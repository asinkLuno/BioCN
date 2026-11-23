import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontProgress, FontStatus } from "../lib/fonts";
import { formatBytes, type ModelProgress, type ModelStatus } from "../lib/models";
import type { UpdateStatus } from "../lib/update";
import { ModelSheet } from "./ModelSheet";
import { resetUpdateCacheForTests } from "./UpdateSection";

const mocks = vi.hoisted(() => ({
  modelsStatus: vi.fn(),
  modelsInstall: vi.fn(),
  modelsCancel: vi.fn(),
  modelsActivate: vi.fn(),
  modelsRemove: vi.fn(),
  onModelProgress: vi.fn(),
  fontStatus: vi.fn(),
  fontInstall: vi.fn(),
  fontCancel: vi.fn(),
  fontRemove: vi.fn(),
  onFontProgress: vi.fn(),
  checkUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  onUpdateProgress: vi.fn(),
  revealUpdate: vi.fn(),
  openReleasePage: vi.fn(),
}));

vi.mock("../lib/fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/fonts")>();
  return {
    ...actual,
    fontStatus: mocks.fontStatus,
    fontInstall: mocks.fontInstall,
    fontCancel: mocks.fontCancel,
    fontRemove: mocks.fontRemove,
    onFontProgress: mocks.onFontProgress,
  };
});

vi.mock("../lib/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/models")>();
  return {
    ...actual,
    modelsStatus: mocks.modelsStatus,
    modelsInstall: mocks.modelsInstall,
    modelsCancel: mocks.modelsCancel,
    modelsActivate: mocks.modelsActivate,
    modelsRemove: mocks.modelsRemove,
    onModelProgress: mocks.onModelProgress,
  };
});

vi.mock("../lib/update", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/update")>();
  return {
    ...actual,
    checkUpdate: mocks.checkUpdate,
    downloadUpdate: mocks.downloadUpdate,
    onUpdateProgress: mocks.onUpdateProgress,
    revealUpdate: mocks.revealUpdate,
    openReleasePage: mocks.openReleasePage,
  };
});

function makeModelStatus(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    installed: ["int8"],
    active: "int8",
    variants: [
      {
        id: "int8",
        label: "快速模式",
        description: "int8 量化权重",
        bytes: 0,
        size: 65 * 1024 * 1024,
        partial: 0,
      },
      {
        id: "fp16",
        label: "高精度模式",
        description: "fp16 权重",
        bytes: 0,
        size: 0,
        partial: 0,
      },
    ],
    manifestError: "offline",
    warning: null,
    ...overrides,
  };
}

function makeUpdateStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: "0.4.1",
    latest: {
      version: "0.5.0",
      notes: "Fix bugs",
      download: {
        name: "BioCN_0.5.0.AppImage",
        platform: "linux",
        size: 32 * 1024 * 1024,
        sha256: "a".repeat(64),
        url: "https://github.com/asinkLuno/BioCN/releases/download/v0.5.0/BioCN_0.5.0.AppImage",
      },
      downloads: [],
    },
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("formats zero, KB, MB, and GB sizes cleanly", () => {
    expect(formatBytes(0)).toBe("大小未知");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(65 * 1024 * 1024)).toBe("65 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("ModelSheet & UpdateSection", () => {
  beforeEach(() => {
    resetUpdateCacheForTests();
    mocks.modelsStatus.mockReset();
    mocks.modelsInstall.mockReset();
    mocks.modelsCancel.mockReset().mockResolvedValue(true);
    mocks.modelsActivate.mockReset();
    mocks.modelsRemove.mockReset();
    mocks.onModelProgress.mockReset().mockResolvedValue(() => {});
    mocks.fontStatus.mockReset().mockResolvedValue({
      installed: false,
      bytes: 16_708_168,
      size: 0,
      partial: 0,
    } satisfies FontStatus);
    mocks.fontInstall.mockReset();
    mocks.fontCancel.mockReset().mockResolvedValue(true);
    mocks.fontRemove.mockReset();
    mocks.onFontProgress.mockReset().mockResolvedValue(() => {});
    mocks.checkUpdate.mockReset().mockResolvedValue({
      currentVersion: "0.4.1",
      latest: null,
    } satisfies UpdateStatus);
    mocks.downloadUpdate.mockReset();
    mocks.onUpdateProgress.mockReset().mockResolvedValue(() => {});
    mocks.revealUpdate.mockReset().mockResolvedValue(undefined);
    mocks.openReleasePage.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("displays installed on-disk size offline and uses progress.total when variant.bytes is 0", async () => {
    let emitProgress: ((event: ModelProgress) => void) | null = null;
    mocks.onModelProgress.mockImplementation(async (cb: (event: ModelProgress) => void) => {
      emitProgress = cb;
      return () => {};
    });
    mocks.modelsStatus.mockResolvedValue(makeModelStatus());

    let resolveInstall!: (s: ModelStatus) => void;
    mocks.modelsInstall.mockImplementation(
      () =>
        new Promise<ModelStatus>((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<ModelSheet open onClose={() => {}} />);

    // Installed variant shows its on-disk `size` (65 MB) even when offline `bytes === 0`.
    expect(await screen.findByText("65 MB")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下载" }));
    await waitFor(() => expect(emitProgress).not.toBeNull());

    act(() => {
      emitProgress!({
        variant: "fp16",
        file: "biocn_tok.ort",
        done: 50,
        total: 100,
      });
    });

    // Progress percentage uses `progress.total` instead of sticking at 0%.
    expect(await screen.findByText(/50%/)).toBeInTheDocument();

    resolveInstall(
      makeModelStatus({
        installed: ["int8", "fp16"],
        active: "fp16",
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());
  });

  it("preserves previous model cards when post-error refresh fails and supports dedicated activate button", async () => {
    const initial = makeModelStatus({
      installed: ["int8", "fp16"],
      active: "int8",
    });
    mocks.modelsStatus.mockResolvedValueOnce(initial).mockRejectedValueOnce("disk busy");
    mocks.modelsActivate.mockResolvedValue(
      makeModelStatus({ installed: ["int8", "fp16"], active: "fp16" }),
    );

    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModelSheet open onClose={() => {}} onChange={onChange} />);

    const activateBtn = await screen.findByRole("button", { name: "启用" });
    await user.click(activateBtn);

    expect(mocks.modelsActivate).toHaveBeenCalledWith("fp16");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("blocks closing ModelSheet during update download and keeps downloaded path if revealUpdate fails", async () => {
    mocks.modelsStatus.mockResolvedValue(makeModelStatus());
    mocks.checkUpdate.mockResolvedValue(makeUpdateStatus());

    let resolveDownload!: (res: { path: string; bytes: number }) => void;
    mocks.downloadUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    mocks.revealUpdate.mockRejectedValueOnce("portal unavailable");

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ModelSheet open onClose={onClose} />);

    const allDownloadBtns = await screen.findAllByRole("button", { name: "下载" });
    expect(allDownloadBtns.length).toBeGreaterThanOrEqual(2);
    await user.click(allDownloadBtns[allDownloadBtns.length - 1]);

    // While app update downloads, ModelSheet close button is disabled.
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();

    resolveDownload({ path: "/tmp/BioCN_0.5.0.AppImage", bytes: 1024 });

    // Even though revealUpdate failed, the verified path is preserved so "再次打开" renders.
    expect(await screen.findByRole("button", { name: "再次打开" })).toBeInTheDocument();
    expect(await screen.findByText(/portal unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeEnabled();
  });

  it("surfaces errors when openReleasePage fails", async () => {
    mocks.modelsStatus.mockResolvedValue(makeModelStatus());
    mocks.checkUpdate.mockRejectedValue("network down");
    mocks.openReleasePage.mockRejectedValue("no browser");

    const user = userEvent.setup();
    render(<ModelSheet open onClose={() => {}} />);

    const openBtn = await screen.findByRole("button", { name: "到发布页下载" });
    await user.click(openBtn);
    expect(await screen.findByText(/no browser/)).toBeInTheDocument();
  });

  it("downloads and removes Source Han Serif SC in Settings and locks closing during download", async () => {
    mocks.modelsStatus.mockResolvedValue(makeModelStatus());
    let emitFontProgress: ((event: FontProgress) => void) | null = null;
    mocks.onFontProgress.mockImplementation(async (cb: (event: FontProgress) => void) => {
      emitFontProgress = cb;
      return () => {};
    });

    let resolveFontInstall!: (s: FontStatus) => void;
    mocks.fontInstall.mockImplementation(
      () =>
        new Promise<FontStatus>((resolve) => {
          resolveFontInstall = resolve;
        }),
    );
    mocks.fontRemove.mockResolvedValue({
      installed: false,
      bytes: 16_708_168,
      size: 0,
      partial: 0,
    } satisfies FontStatus);

    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModelSheet open onClose={() => {}} onChange={onChange} />);

    const downloadBtn = await screen.findByRole("button", { name: "下载字体" });
    await user.click(downloadBtn);
    await waitFor(() => expect(emitFontProgress).not.toBeNull());
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();

    act(() => {
      emitFontProgress!({ done: 8_354_084, total: 16_708_168 });
    });
    expect(await screen.findByText(/50%/)).toBeInTheDocument();

    resolveFontInstall({
      installed: true,
      bytes: 16_708_168,
      size: 16_708_168,
      partial: 0,
    });
    expect(await screen.findByText("已下载")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "移除字体" }));
    expect(await screen.findByRole("button", { name: "下载字体" })).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("cancels model and font downloads cleanly without an error alert and shows resume state", async () => {
    const initialModels = makeModelStatus({ manifestError: null });
    const partialModels = makeModelStatus({
      manifestError: null,
      variants: [
        initialModels.variants[0],
        { ...initialModels.variants[1], bytes: 78 * 1024 * 1024, partial: 12 * 1024 * 1024 },
      ],
    });
    mocks.modelsStatus.mockResolvedValueOnce(initialModels).mockResolvedValueOnce(partialModels);

    let rejectModelInstall!: (reason?: unknown) => void;
    mocks.modelsInstall.mockImplementation(
      () =>
        new Promise<ModelStatus>((_resolve, reject) => {
          rejectModelInstall = reject;
        }),
    );

    mocks.fontStatus
      .mockResolvedValueOnce({
        installed: false,
        bytes: 16_708_168,
        size: 0,
        partial: 0,
      })
      .mockResolvedValueOnce({
        installed: false,
        bytes: 16_708_168,
        size: 0,
        partial: 5 * 1024 * 1024,
      });
    let rejectFontInstall!: (reason?: unknown) => void;
    mocks.fontInstall.mockImplementation(
      () =>
        new Promise<FontStatus>((_resolve, reject) => {
          rejectFontInstall = reject;
        }),
    );

    const user = userEvent.setup();
    render(<ModelSheet open onClose={() => {}} />);

    // Cancel model download
    await user.click(await screen.findByRole("button", { name: "下载" }));
    await user.click(await screen.findByRole("button", { name: "取消下载 高精度模式" }));
    expect(mocks.modelsCancel).toHaveBeenCalledTimes(1);
    rejectModelInstall("cancelled: 下载已取消");

    expect(await screen.findByRole("button", { name: "继续下载" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());

    // Cancel serif font download
    await user.click(screen.getByRole("button", { name: "下载字体" }));
    await user.click(await screen.findByRole("button", { name: "取消下载思源宋体" }));
    expect(mocks.fontCancel).toHaveBeenCalledTimes(1);
    rejectFontInstall("cancelled: 下载已取消");

    expect(await screen.findByRole("button", { name: "继续下载字体" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "完成" })).toBeEnabled());
  });
});
