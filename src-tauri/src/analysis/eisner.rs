//! Port of `hanlp.components.parsers.alg` `decode_dep` (tree=True, proj=True)
//! for a single sentence: argmax first, Eisner only when the argmax parse is
//! not a projective tree. Identical branch structure to HanLP so the heads
//! match exactly — always running Eisner instead would occasionally pick a
//! different (better) tree than HanLP reports.
//!
//! `scores` is `s_arc` from the DEP model, row-major `[L, L]` with `L = n + 1`
//! (row/col 0 = root); `scores[d][h]` = score of "word d's head is h".
//!
//! HanLP's eisner runs on `scores.permute(2, 1, 0)` — a TRANSPOSED view
//! (`sc[r][c] = scores[c][r]`) — and every stripe/diagonal below is expressed
//! in that transposed space, verified cell-by-cell against torch on the
//! `alg.py` docstring example. Storage stays `f32` so intermediate sums round
//! like torch's float32.

const NEG_INF: f32 = f32::NEG_INFINITY;

/// `hanlp_common.conll.isprojective` (heads of words 1..n, 0 = root).
pub fn is_projective(sequence: &[i32]) -> bool {
    let mut pairs: Vec<(i32, i32)> = Vec::with_capacity(sequence.len()); // (head, dep), dep 1-based
    for (d, head) in sequence.iter().enumerate() {
        if *head >= 0 {
            pairs.push((*head, d as i32 + 1));
        }
    }
    for i in 0..pairs.len() {
        let (hi, di) = pairs[i];
        for &(hj, dj) in &pairs[i + 1..] {
            let li = hi.min(di);
            let ri = hi.max(di);
            let lj = hj.min(dj);
            let rj = hj.max(dj);
            if li <= hj && hj <= ri && hi == dj {
                return false;
            }
            if lj <= hi && hi <= rj && hj == di {
                return false;
            }
            if ((li < lj && lj < ri) || (li < rj && rj < ri))
                && (li - lj) * (ri - rj) > 0
            {
                return false;
            }
        }
    }
    true
}

/// `hanlp alg.istree(sequence, proj=True, multiroot=False)`. Cycle detection
/// follows head chains (equivalent to `next(tarjan(...)) is None`): a cycle
/// exists iff some walk never reaches the root; heads outside the sequence
/// are dangling, like tarjan's out-of-range shift.
pub fn is_tree(sequence: &[i32], proj: bool) -> bool {
    if proj && !is_projective(sequence) {
        return false;
    }
    let mut n_roots = 0;
    for &h in sequence {
        if h == 0 {
            n_roots += 1;
        }
    }
    if n_roots == 0 || n_roots > 1 {
        return false;
    }
    for (i, &h) in sequence.iter().enumerate() {
        if h == i as i32 + 1 {
            return false; // self-loop
        }
    }
    let n = sequence.len();
    // 3-color cycle detection: 0 = unvisited, 1 = on current path, 2 = verified acyclic.
    let mut state = vec![0u8; n];
    let mut path = Vec::new();
    for start in 0..n {
        if state[start] == 2 {
            continue;
        }
        path.clear();
        let mut v = start;
        loop {
            match state[v] {
                1 => return false, // cycle
                2 => break,
                _ => {
                    state[v] = 1;
                    path.push(v);
                }
            }
            let h = sequence[v] - 1;
            if h < 0 || h >= n as i32 {
                break; // root / dangling
            }
            v = h as usize;
        }
        for node in path.drain(..) {
            state[node] = 2;
        }
    }
    true
}

fn backtrack(
    p_i: &[i32],
    p_c: &[i32],
    heads: &mut [i32],
    start_i: usize,
    start_j: usize,
    start_complete: bool,
    l: usize,
) {
    let mut stack = Vec::with_capacity(l * 2);
    stack.push((start_i, start_j, start_complete));
    while let Some((i, j, complete)) = stack.pop() {
        if i == j {
            continue;
        }
        if complete {
            let r = p_c[i * l + j] as usize;
            stack.push((r, j, true));
            stack.push((i, r, false));
        } else {
            let r = p_i[i * l + j] as usize;
            heads[j] = i as i32;
            let a = i.min(j);
            let b = i.max(j);
            stack.push((b, r + 1, true));
            stack.push((a, r, true));
        }
    }
}

/// First-order Eisner (`hanlp alg.eisner`, batch = 1) on transposed scores.
///
/// `scores` is `[L, L]` row-major (`scores[dep][head]`). Transposed view `sc`
/// satisfies `sc[a][b] = scores[b][a]`, indexed directly without allocating
/// a separate `l * l` transpose buffer.
fn eisner(scores: &[f32], n: usize) -> Vec<i32> {
    if n == 0 {
        return Vec::new();
    }
    let l = n + 1;

    let mut s_i = vec![NEG_INF; l * l];
    let mut s_c = vec![NEG_INF; l * l];
    let mut p_i = vec![0i32; l * l];
    let mut p_c = vec![0i32; l * l];
    for i in 0..l {
        s_c[i * l + i] = 0.0;
    }

    for w in 1..l {
        for i in 0..(l - w) {
            // ilr[i][j] = s_c[i][i+j] + s_c[w+i][1+i+j]  (reads the DP table)
            let mut best = NEG_INF;
            let mut best_j = 0usize;
            for j in 0..w {
                let v = s_c[i * l + (i + j)] + s_c[(w + i) * l + (1 + i + j)];
                if v > best {
                    best = v;
                    best_j = j;
                }
            }
            // I on diagonal(-w): sc[i+w][i] == scores[i][i+w]
            s_i[(i + w) * l + i] = best + scores[i * l + (i + w)];
            p_i[(i + w) * l + i] = best_j as i32 + i as i32;
            // I on diagonal(+w): sc[i][i+w] == scores[i+w][i]
            s_i[i * l + (i + w)] = best + scores[(i + w) * l + i];
            p_i[i * l + (i + w)] = best_j as i32 + i as i32;

            // cl[i][j] = sc[i+j][i] + sI[w+i][i+j]   (stripe0 (0,0) + stripe1 (w,0))
            let mut cl_best = NEG_INF;
            let mut cl_best_j = 0usize;
            for j in 0..w {
                let v = s_c[(i + j) * l + i] + s_i[(w + i) * l + (i + j)];
                if v > cl_best {
                    cl_best = v;
                    cl_best_j = j;
                }
            }
            s_c[(i + w) * l + i] = cl_best;
            p_c[(i + w) * l + i] = cl_best_j as i32 + i as i32;

            // cr[i][j] = sI[i][1+i+j] + sc[1+i+j][w+i]  (stripe1 (0,1) + stripe0 (1,w))
            let mut cr_best = NEG_INF;
            let mut cr_best_j = 0usize;
            for j in 0..w {
                let v = s_i[i * l + (1 + i + j)] + s_c[(1 + i + j) * l + (w + i)];
                if v > cr_best {
                    cr_best = v;
                    cr_best_j = j;
                }
            }
            // single-root constraint: s_c[0, w] = -inf unless w == n (lens)
            s_c[i * l + (i + w)] = if i == 0 && w != n { NEG_INF } else { cr_best };
            p_c[i * l + (i + w)] = cr_best_j as i32 + i as i32 + 1;
        }
    }

    let mut heads = vec![0i32; n + 1];
    backtrack(&p_i, &p_c, &mut heads, 0, n, true, l);
    heads[1..].to_vec()
}

/// `decode_dep(tree=True, proj=True)` for one sentence.
/// Returns `heads[0..n-1]` where `heads[k]` is the head (0 = root) of word k+1.
pub fn decode_dep_heads(s_arc: &[f32], n: usize) -> Vec<i32> {
    if n == 0 {
        return Vec::new();
    }
    let l = n + 1;
    let mut argmax = vec![0i32; n];
    for d in 1..=n {
        let mut best = NEG_INF;
        let mut arg = 0i32;
        for h in 0..=n {
            let v = s_arc[d * l + h];
            if v > best {
                best = v;
                arg = h as i32;
            }
        }
        argmax[d - 1] = arg;
    }
    if is_tree(&argmax, true) {
        return argmax;
    }
    eisner(s_arc, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eisner_docstring_example() {
        // hanlp alg.py docstring: torch returns [0, 2, 0, 2] incl. root row;
        // words 1..3 -> [2, 0, 2].
        #[rustfmt::skip]
        let scores: Vec<f32> = vec![
            -13.5026, -18.37, -13.0033, -16.6809,
            -36.5235, -28.6344, -28.4696, -31.675,
            -2.9084, -7.4825, -1.4861, -6.8709,
            -29.488, -27.6905, -26.1498, -27.0233,
        ];
        assert_eq!(decode_dep_heads(&scores, 3), vec![2, 0, 2]);
    }

    #[test]
    fn istree_isprojective_examples() {
        assert!(!is_tree(&[3, 0, 0, 3], true)); // proj example, also multi-root
        assert!(!is_projective(&[2, -1, 1]));
        assert!(!is_projective(&[3, -1, 2]));
        assert!(!is_tree(&[2, 5, 0, 3, 1], true)); // tarjan cycle example
        assert!(is_tree(&[0, 1, 2], true)); // simple chain to root
        assert!(!is_tree(&[2, 0, 1], true)); // matches hanlp istree(proj=True)
    }

    #[test]
    fn decode_dep_heads_handles_empty_input() {
        assert_eq!(decode_dep_heads(&[], 0), Vec::<i32>::new());
    }
}
