//! Persistent three-stage priority pipeline scheduler (TOK -> POS -> DEP).
//!
//! Instead of spawning 3 fresh OS threads per small batch (which adds pipeline
//! fill/drain bubbles and thousands of thread creates per book) or coordinating
//! priorities via blocking `sleep` loops, a single loaded [`PipelineScheduler`]
//! keeps one dedicated thread per stage alive for the lifetime of the loaded
//! sessions.
//!
//! Every inference caller submits its sentences with a [`Priority`] and a
//! shared cancel flag:
//!
//! * [`Priority::Reader`] (P0) — active chapter progressive coloring
//! * [`Priority::Export`] (P1) — foreground EPUB export retrying missing spans
//! * [`Priority::Prefetch`] (P2) — silent next-chapter prefetch
//! * [`Priority::Background`] (P3) — whole-book background coloring
//!
//! Stage 1 (TOK) always pulls the next single sentence from the highest-priority
//! non-cancelled job, giving single-sentence preemption latency (~milliseconds)
//! while keeping steady-state throughput at the full 3-stage pipeline ceiling.
//!
//! Bounded inter-stage channels (capacity 2) cap intermediate memory and limit
//! how many lower-priority sentences can sit between stages when P0 arrives.
//! Reply channels are pre-sized to each job's sentence count so worker threads
//! deliver answers via non-blocking `try_send` and can never deadlock.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::async_runtime::{Receiver, Sender, channel};

use crate::analysis::decode::Word;
use crate::analysis::engine::Sessions;
use crate::analysis::pipeline::{PosBundle, SentenceAnswer, dep_stage, pos_stage, tok_stage};
use crate::analysis::resources::{BioCNResources, Result};
use crate::analysis::roles::Segment;

/// Inter-stage bounded queue depth. Small enough that P0 preempts within a few
/// sentences (~10 ms), large enough to absorb per-sentence length jitter in
/// steady state.
const STAGE_QUEUE_CAP: usize = 2;

/// Scheduling priority, ordered from most urgent (lowest discriminant) to least.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// P0: Current chapter on screen — preempts all other work.
    Reader = 0,
    /// P1: Foreground EPUB export retrying uncached sentences.
    Export = 1,
    /// P2: Silent prefetch for the upcoming chapter.
    Prefetch = 2,
    /// P3: Background whole-book coloring job.
    Background = 3,
}

/// One completed sentence returned on a job's async stream:
/// `(index_in_submission, sentence_text, analysis_answer)`.
pub type ScheduledResult = (usize, String, SentenceAnswer);

/// Abstraction over the three pipeline stages so the scheduler's priority,
/// preemption, cancellation, shutdown, and idle logic can be unit-tested
/// deterministically without loading ONNX weights from disk.
pub trait StageRunner: Send + Sync + 'static {
    type TokOut: Send + 'static;
    type PosOut: Send + 'static;

    fn run_tok(&self, sentence: &str) -> Result<Option<Self::TokOut>>;
    fn run_pos(&self, tok: Self::TokOut) -> Result<Self::PosOut>;
    fn run_dep(&self, pos: Self::PosOut) -> Result<Vec<Segment>>;
}

/// Production runner driving the three ONNX Runtime sessions.
pub struct OrtRunner {
    resources: BioCNResources,
    sessions: Sessions,
}

impl StageRunner for OrtRunner {
    type TokOut = (Vec<u16>, Vec<Word>);
    type PosOut = PosBundle;

    fn run_tok(&self, sentence: &str) -> Result<Option<Self::TokOut>> {
        tok_stage(&self.resources, &self.sessions, sentence)
    }

    fn run_pos(&self, (text, words): Self::TokOut) -> Result<Self::PosOut> {
        pos_stage(&self.resources, &self.sessions, text, words)
    }

    fn run_dep(&self, bundle: Self::PosOut) -> Result<Vec<Segment>> {
        dep_stage(&self.resources, &self.sessions, bundle)
    }
}

/// Persistent three-stage priority pipeline backed by ONNX Runtime sessions.
pub struct PipelineScheduler {
    inner: Scheduler<OrtRunner>,
}

impl PipelineScheduler {
    pub fn new(
        resources: BioCNResources,
        sessions: Sessions,
        idle_timeout: Option<Duration>,
        on_idle: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        Self {
            inner: Scheduler::new(OrtRunner { resources, sessions }, idle_timeout, on_idle),
        }
    }

    /// Enqueues `sentences` at `priority` and returns an async stream of results.
    ///
    /// Answers may arrive slightly out of index order when an empty or failing
    /// sentence short-circuits at TOK/POS ahead of an earlier sentence in DEP.
    /// Setting `cancel` (or dropping the returned receiver) skips remaining
    /// queued and in-flight stages promptly.
    pub fn submit(
        &self,
        priority: Priority,
        cancel: Arc<AtomicBool>,
        sentences: Vec<String>,
    ) -> Receiver<ScheduledResult> {
        self.inner.submit(priority, cancel, sentences)
    }

    /// Whether the scheduler has no active/queued work and has been idle for at
    /// least `timeout`. Used by the idle-reaper task to verify no new job
    /// arrived between the callback firing and acquiring the analyzer slot lock.
    pub fn is_idle(&self, timeout: Duration) -> bool {
        self.inner.is_idle(timeout)
    }

    /// Wakes the TOK stage (e.g. after flipping a cancel flag) so cancelled
    /// queued jobs are pruned promptly.
    pub fn wake(&self) {
        self.inner.wake();
    }
}

struct QueuedJob {
    priority: Priority,
    seq: u64,
    cancel: Arc<AtomicBool>,
    sentences: VecDeque<(usize, String)>,
    reply_tx: Sender<ScheduledResult>,
}

impl QueuedJob {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.reply_tx.is_closed()
    }
}

struct QueueState {
    jobs: Vec<QueuedJob>,
    next_seq: u64,
    in_flight: usize,
    last_activity: Instant,
    /// Throttles repeated `on_idle` notifications without touching
    /// `last_activity` (so `is_idle(timeout)` stays true while the async
    /// reaper handles the callback).
    last_idle_notify: Option<Instant>,
    shutdown: bool,
}

impl QueueState {
    fn pop_next(&mut self, shared: &Arc<Shared>) -> Option<WorkItem<()>> {
        self.jobs.retain(|j| !j.is_cancelled() && !j.sentences.is_empty());
        let best_pos = self
            .jobs
            .iter()
            .enumerate()
            .min_by_key(|(_, j)| (j.priority, j.seq))
            .map(|(i, _)| i)?;

        let job = &mut self.jobs[best_pos];
        let (index, sentence) = job.sentences.pop_front()?;
        let cancel = job.cancel.clone();
        let reply_tx = job.reply_tx.clone();
        if job.sentences.is_empty() {
            self.jobs.swap_remove(best_pos);
        }

        self.in_flight += 1;
        self.last_activity = Instant::now();
        self.last_idle_notify = None;
        Some(WorkItem {
            index,
            sentence,
            cancel,
            reply_tx,
            payload: (),
            _guard: InFlightGuard {
                shared: shared.clone(),
            },
        })
    }
}

struct Shared {
    state: Mutex<QueueState>,
    cv: Condvar,
    shutdown: AtomicBool,
}

/// Decrements `in_flight` on every exit path (normal delivery, early
/// short-circuit, cancellation skip, or panic) and refreshes `last_activity`.
struct InFlightGuard {
    shared: Arc<Shared>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.in_flight = state.in_flight.saturating_sub(1);
        state.last_activity = Instant::now();
        state.last_idle_notify = None;
        if state.in_flight == 0 && state.jobs.is_empty() {
            self.shared.cv.notify_all();
        }
    }
}

struct WorkItem<T> {
    index: usize,
    sentence: String,
    cancel: Arc<AtomicBool>,
    reply_tx: Sender<ScheduledResult>,
    payload: T,
    _guard: InFlightGuard,
}

impl<T> WorkItem<T> {
    fn is_cancelled(&self, shared: &Shared) -> bool {
        shared.shutdown.load(Ordering::Acquire)
            || self.cancel.load(Ordering::Relaxed)
            || self.reply_tx.is_closed()
    }

    fn with_payload<U>(self, payload: U) -> WorkItem<U> {
        WorkItem {
            index: self.index,
            sentence: self.sentence,
            cancel: self.cancel,
            reply_tx: self.reply_tx,
            payload,
            _guard: self._guard,
        }
    }
}

/// Ensures any unexpected exit from `tok_loop` marks the scheduler shut down
/// and drains queued jobs so callers never hang waiting on closed channels.
struct TokExitGuard {
    shared: Arc<Shared>,
}

impl Drop for TokExitGuard {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.shutdown = true;
        state.jobs.clear();
        self.shared.cv.notify_all();
    }
}

/// Generic persistent 3-stage priority scheduler.
pub struct Scheduler<R: StageRunner> {
    shared: Arc<Shared>,
    handles: Vec<JoinHandle<()>>,
    _marker: std::marker::PhantomData<R>,
}

impl<R: StageRunner> Scheduler<R> {
    pub fn new(
        runner: R,
        idle_timeout: Option<Duration>,
        on_idle: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        let runner = Arc::new(runner);
        let shared = Arc::new(Shared {
            state: Mutex::new(QueueState {
                jobs: Vec::new(),
                next_seq: 0,
                in_flight: 0,
                last_activity: Instant::now(),
                last_idle_notify: None,
                shutdown: false,
            }),
            cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
        });

        let (tok_tx, tok_rx) = mpsc::sync_channel::<WorkItem<R::TokOut>>(STAGE_QUEUE_CAP);
        let (dep_tx, dep_rx) = mpsc::sync_channel::<WorkItem<R::PosOut>>(STAGE_QUEUE_CAP);

        let tok_handle = {
            let shared = shared.clone();
            let runner = runner.clone();
            std::thread::Builder::new()
                .name("biocn-tok".into())
                .spawn(move || {
                    tok_loop(&shared, runner.as_ref(), tok_tx, idle_timeout, on_idle);
                })
                .expect("spawn biocn-tok worker")
        };

        let pos_handle = {
            let shared = shared.clone();
            let runner = runner.clone();
            std::thread::Builder::new()
                .name("biocn-pos".into())
                .spawn(move || {
                    pos_loop(&shared, runner.as_ref(), tok_rx, dep_tx);
                })
                .expect("spawn biocn-pos worker")
        };

        let dep_handle = {
            let shared = shared.clone();
            let runner = runner;
            std::thread::Builder::new()
                .name("biocn-dep".into())
                .spawn(move || {
                    dep_loop(&shared, runner.as_ref(), dep_rx);
                })
                .expect("spawn biocn-dep worker")
        };

        Self {
            shared,
            handles: vec![tok_handle, pos_handle, dep_handle],
            _marker: std::marker::PhantomData,
        }
    }

    pub fn submit(
        &self,
        priority: Priority,
        cancel: Arc<AtomicBool>,
        sentences: Vec<String>,
    ) -> Receiver<ScheduledResult> {
        if sentences.is_empty() {
            let (_tx, rx) = channel(1);
            return rx;
        }
        // Pre-sized to the submission length so every sentence has a guaranteed
        // slot and worker threads deliver via non-blocking `try_send`.
        let (reply_tx, reply_rx) = channel(sentences.len());
        let queued: VecDeque<(usize, String)> = sentences.into_iter().enumerate().collect();

        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return reply_rx;
        }
        let seq = state.next_seq;
        state.next_seq += 1;
        state.last_activity = Instant::now();
        state.last_idle_notify = None;
        state.jobs.push(QueuedJob {
            priority,
            seq,
            cancel,
            sentences: queued,
            reply_tx,
        });
        self.shared.cv.notify_all();
        reply_rx
    }

    pub fn is_idle(&self, timeout: Duration) -> bool {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.jobs.retain(|j| !j.is_cancelled() && !j.sentences.is_empty());
        state.jobs.is_empty() && state.in_flight == 0 && state.last_activity.elapsed() >= timeout
    }

    pub fn wake(&self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.jobs.retain(|j| !j.is_cancelled() && !j.sentences.is_empty());
        self.shared.cv.notify_all();
    }
}

impl<R: StageRunner> Drop for Scheduler<R> {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::Release);
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.shutdown = true;
            // Dropping queued jobs closes their reply_tx so any waiter unblocks.
            state.jobs.clear();
            self.shared.cv.notify_all();
        }
        // Joining in stage order (TOK -> POS -> DEP) guarantees every session
        // reference is dropped before Drop returns (important on Windows before
        // deleting/renaming model files).
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

fn tok_loop<R: StageRunner>(
    shared: &Arc<Shared>,
    runner: &R,
    tok_tx: mpsc::SyncSender<WorkItem<R::TokOut>>,
    idle_timeout: Option<Duration>,
    on_idle: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    let _exit_guard = TokExitGuard {
        shared: shared.clone(),
    };
    loop {
        let work = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if state.shutdown {
                    return;
                }
                if let Some(work) = state.pop_next(shared) {
                    break work;
                }
                if let Some(timeout) = idle_timeout {
                    if state.in_flight == 0 {
                        let idle_elapsed = state.last_activity.elapsed();
                        let notify_elapsed = state.last_idle_notify.map(|t| t.elapsed());
                        let ready_to_notify = idle_elapsed >= timeout
                            && notify_elapsed.is_none_or(|e| e >= timeout);
                        if ready_to_notify {
                            // Throttle retries via `last_idle_notify` without
                            // resetting `last_activity`, so `is_idle(timeout)`
                            // remains true when the async reaper runs.
                            state.last_idle_notify = Some(Instant::now());
                            let cb = on_idle.clone();
                            drop(state);
                            if let Some(cb) = cb {
                                cb();
                            }
                            state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                            continue;
                        }
                        let wait_activity = timeout.saturating_sub(idle_elapsed);
                        let wait_notify = notify_elapsed
                            .map(|e| timeout.saturating_sub(e))
                            .unwrap_or(Duration::ZERO);
                        let wait_for = wait_activity.max(wait_notify);
                        let (s, _) = shared
                            .cv
                            .wait_timeout(state, wait_for)
                            .unwrap_or_else(|e| e.into_inner());
                        state = s;
                    } else {
                        state = shared.cv.wait(state).unwrap_or_else(|e| e.into_inner());
                    }
                } else {
                    state = shared.cv.wait(state).unwrap_or_else(|e| e.into_inner());
                }
            }
        };

        if work.is_cancelled(shared) {
            continue;
        }
        match runner.run_tok(&work.sentence) {
            Ok(Some(tok_out)) => {
                if work.is_cancelled(shared) {
                    continue;
                }
                if tok_tx.send(work.with_payload(tok_out)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = work.reply_tx.try_send((work.index, work.sentence, Ok(None)));
            }
            Err(error) => {
                let _ = work
                    .reply_tx
                    .try_send((work.index, work.sentence, Err(error.to_string())));
            }
        }
    }
}

fn pos_loop<R: StageRunner>(
    shared: &Arc<Shared>,
    runner: &R,
    tok_rx: mpsc::Receiver<WorkItem<R::TokOut>>,
    dep_tx: mpsc::SyncSender<WorkItem<R::PosOut>>,
) {
    for work in tok_rx {
        if work.is_cancelled(shared) {
            continue;
        }
        let WorkItem {
            index,
            sentence,
            cancel,
            reply_tx,
            payload: tok_out,
            _guard,
        } = work;
        match runner.run_pos(tok_out) {
            Ok(pos_out) => {
                if shared.shutdown.load(Ordering::Acquire)
                    || cancel.load(Ordering::Relaxed)
                    || reply_tx.is_closed()
                {
                    continue;
                }
                let next = WorkItem {
                    index,
                    sentence,
                    cancel,
                    reply_tx,
                    payload: pos_out,
                    _guard,
                };
                if dep_tx.send(next).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = reply_tx.try_send((index, sentence, Err(error.to_string())));
            }
        }
    }
}

fn dep_loop<R: StageRunner>(
    shared: &Arc<Shared>,
    runner: &R,
    dep_rx: mpsc::Receiver<WorkItem<R::PosOut>>,
) {
    for work in dep_rx {
        if work.is_cancelled(shared) {
            continue;
        }
        let answer = runner
            .run_dep(work.payload)
            .map(Some)
            .map_err(|e| e.to_string());
        let _ = work.reply_tx.try_send((work.index, work.sentence, answer));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Role;
    use std::sync::atomic::AtomicUsize;

    struct FakeRunnerProbe {
        tok_order: Arc<Mutex<Vec<String>>>,
        dropped: Arc<AtomicBool>,
        tok_calls: Arc<AtomicUsize>,
    }

    struct FakeRunner {
        tok_delay: Duration,
        tok_order: Arc<Mutex<Vec<String>>>,
        dropped: Arc<AtomicBool>,
        tok_calls: Arc<AtomicUsize>,
    }

    impl FakeRunner {
        fn new(tok_delay: Duration) -> (Self, FakeRunnerProbe) {
            let order = Arc::new(Mutex::new(Vec::new()));
            let dropped = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    tok_delay,
                    tok_order: order.clone(),
                    dropped: dropped.clone(),
                    tok_calls: calls.clone(),
                },
                FakeRunnerProbe {
                    tok_order: order,
                    dropped,
                    tok_calls: calls,
                },
            )
        }
    }

    impl Drop for FakeRunner {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl StageRunner for FakeRunner {
        type TokOut = String;
        type PosOut = String;

        fn run_tok(&self, sentence: &str) -> Result<Option<Self::TokOut>> {
            self.tok_calls.fetch_add(1, Ordering::SeqCst);
            if !self.tok_delay.is_zero() {
                std::thread::sleep(self.tok_delay);
            }
            self.tok_order.lock().unwrap().push(sentence.to_owned());
            if sentence == "EMPTY" {
                return Ok(None);
            }
            if sentence == "ERR_TOK" {
                return Err("tok boom".into());
            }
            Ok(Some(sentence.to_owned()))
        }

        fn run_pos(&self, tok: Self::TokOut) -> Result<Self::PosOut> {
            if tok == "ERR_POS" {
                return Err("pos boom".into());
            }
            Ok(tok)
        }

        fn run_dep(&self, pos: Self::PosOut) -> Result<Vec<Segment>> {
            if pos == "ERR_DEP" {
                return Err("dep boom".into());
            }
            Ok(vec![Segment {
                text: pos,
                start: 0,
                role: Role::Subject,
            }])
        }
    }

    fn collect_all(mut rx: Receiver<ScheduledResult>) -> Vec<ScheduledResult> {
        tauri::async_runtime::block_on(async {
            let mut out = Vec::new();
            while let Some(item) = rx.recv().await {
                out.push(item);
            }
            out
        })
    }

    #[test]
    fn strict_priority_order_and_midstream_preemption() {
        // Use a small TOK delay so Background is mid-stream when Reader/Export/Prefetch arrive.
        let (runner, probe) = FakeRunner::new(Duration::from_millis(8));
        let scheduler = Scheduler::new(runner, None, None);

        let bg_sentences: Vec<String> = (0..12).map(|i| format!("bg-{i}")).collect();
        let rx_bg = scheduler.submit(
            Priority::Background,
            Arc::new(AtomicBool::new(false)),
            bg_sentences,
        );

        // Give TOK time to start pulling bg-0 (and maybe bg-1).
        std::thread::sleep(Duration::from_millis(12));

        // Submit Prefetch, Export, and Reader concurrently while Background is running.
        let rx_prefetch = scheduler.submit(
            Priority::Prefetch,
            Arc::new(AtomicBool::new(false)),
            vec!["pf-0".into(), "pf-1".into()],
        );
        let rx_export = scheduler.submit(
            Priority::Export,
            Arc::new(AtomicBool::new(false)),
            vec!["ex-0".into(), "ex-1".into()],
        );
        let rx_reader = scheduler.submit(
            Priority::Reader,
            Arc::new(AtomicBool::new(false)),
            vec!["rd-0".into(), "rd-1".into()],
        );

        let rd_res = collect_all(rx_reader);
        let ex_res = collect_all(rx_export);
        let pf_res = collect_all(rx_prefetch);
        let bg_res = collect_all(rx_bg);

        assert_eq!(rd_res.len(), 2);
        assert_eq!(ex_res.len(), 2);
        assert_eq!(pf_res.len(), 2);
        assert_eq!(bg_res.len(), 12, "preempted background job must resume and finish all sentences");

        // Verify preemption happened well before Background finished all 12 items,
        // and Reader ran ahead of Export, which ran ahead of Prefetch, which ran ahead of remaining Background.
        let executed = probe.tok_order.lock().unwrap();
        let pos = |label: &str| executed.iter().position(|s| s == label).unwrap();
        assert!(pos("rd-1") < pos("bg-11"), "Reader must preempt Background: {executed:?}");
        assert!(pos("rd-1") < pos("ex-1"), "Reader must precede Export: {executed:?}");
        assert!(pos("ex-1") < pos("pf-1"), "Export must precede Prefetch: {executed:?}");
        assert!(pos("pf-1") < pos("bg-11"), "Prefetch must precede remaining Background: {executed:?}");
    }

    #[test]
    fn cancellation_skips_queued_sentences_promptly() {
        let (runner, probe) = FakeRunner::new(Duration::from_millis(5));
        let scheduler = Scheduler::new(runner, None, None);

        let cancel = Arc::new(AtomicBool::new(false));
        let sentences: Vec<String> = (0..100).map(|i| format!("s-{i}")).collect();
        let rx = scheduler.submit(Priority::Background, cancel.clone(), sentences);

        std::thread::sleep(Duration::from_millis(15));
        cancel.store(true, Ordering::Relaxed);
        scheduler.wake();

        let results = collect_all(rx);
        let ran = probe.tok_calls.load(Ordering::SeqCst);
        assert!(
            results.len() < 30 && ran < 30,
            "cancelled job should skip most remaining work (results={}, tok_calls={})",
            results.len(),
            ran
        );
    }

    #[test]
    fn isolates_stage_errors_and_empty_sentences() {
        let (runner, _probe) = FakeRunner::new(Duration::ZERO);
        let scheduler = Scheduler::new(runner, None, None);

        let sentences = vec![
            "OK1".into(),
            "EMPTY".into(),
            "ERR_TOK".into(),
            "ERR_POS".into(),
            "ERR_DEP".into(),
            "OK2".into(),
        ];
        let mut results = collect_all(scheduler.submit(
            Priority::Reader,
            Arc::new(AtomicBool::new(false)),
            sentences,
        ));
        results.sort_by_key(|(idx, _, _)| *idx);

        assert_eq!(results.len(), 6);
        assert!(matches!(&results[0].2, Ok(Some(segs)) if segs[0].text == "OK1"));
        assert!(matches!(&results[1].2, Ok(None)));
        assert!(matches!(&results[2].2, Err(e) if e.contains("tok boom")));
        assert!(matches!(&results[3].2, Err(e) if e.contains("pos boom")));
        assert!(matches!(&results[4].2, Err(e) if e.contains("dep boom")));
        assert!(matches!(&results[5].2, Ok(Some(segs)) if segs[0].text == "OK2"));
    }

    #[test]
    fn idle_callback_fires_when_idle_and_drop_joins_all_workers() {
        let (runner, probe) = FakeRunner::new(Duration::ZERO);
        let idle_hits = Arc::new(AtomicUsize::new(0));
        let idle_hits_cb = idle_hits.clone();
        let scheduler = Scheduler::new(
            runner,
            Some(Duration::from_millis(40)),
            Some(Arc::new(move || {
                idle_hits_cb.fetch_add(1, Ordering::SeqCst);
            })),
        );

        let rx = scheduler.submit(
            Priority::Reader,
            Arc::new(AtomicBool::new(false)),
            vec!["hello".into()],
        );
        assert_eq!(collect_all(rx).len(), 1);
        assert_eq!(idle_hits.load(Ordering::SeqCst), 0);

        // Wait past idle timeout.
        std::thread::sleep(Duration::from_millis(90));
        assert!(
            idle_hits.load(Ordering::SeqCst) >= 1,
            "idle callback must fire after inactivity"
        );
        assert!(
            scheduler.is_idle(Duration::from_millis(40)),
            "scheduler must still report is_idle(timeout) when on_idle fires"
        );
        assert!(!probe.dropped.load(Ordering::SeqCst));

        // Dropping the scheduler must join all 3 worker threads and release the runner immediately.
        drop(scheduler);
        assert!(
            probe.dropped.load(Ordering::SeqCst),
            "runner must be dropped synchronously when Scheduler drops"
        );
    }
}
