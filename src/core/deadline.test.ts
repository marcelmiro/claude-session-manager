import { describe, expect, test } from "bun:test";
import { DeadlineError, retryOnDeadline, withDeadline } from "./deadline";

const never = () => new Promise<string>(() => {});

describe("withDeadline", () => {
  test("passes through a resolving promise", async () => {
    expect(await withDeadline(Promise.resolve("ok"), 50, "x")).toBe("ok");
  });

  test("passes through a rejection unchanged", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 50, "x")).rejects.toThrow("boom");
  });

  test("rejects with DeadlineError when the promise never settles", async () => {
    await expect(withDeadline(never(), 10, "lost ps")).rejects.toBeInstanceOf(DeadlineError);
  });
});

describe("retryOnDeadline", () => {
  test("retries once after a timeout and returns the retry's value", async () => {
    let calls = 0;
    const result = await retryOnDeadline(() => (++calls === 1 ? never() : Promise.resolve("second")), 10, "x");
    expect(result).toBe("second");
    expect(calls).toBe(2);
  });

  test("throws DeadlineError when both attempts time out", async () => {
    let calls = 0;
    await expect(
      retryOnDeadline(() => {
        calls++;
        return never();
      }, 10, "x"),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(calls).toBe(2);
  });

  test("does not retry a real (non-deadline) failure", async () => {
    let calls = 0;
    await expect(
      retryOnDeadline(() => {
        calls++;
        return Promise.reject(new Error("real"));
      }, 50, "x"),
    ).rejects.toThrow("real");
    expect(calls).toBe(1);
  });
});
