// 错误码表（规范第九章）+ 结构化错误 + 警告码
export type ErrorCode =
  | "infeasible"
  | "needs_clarification"
  | "deny_auto"
  | "deny_with_override"
  | "deny_hard"
  | "unknown_physical_state"
  | "resource_corrupted"
  | "timeout"
  | "target_mismatch"; // v3：计划与执行时设备 serial 不一致

const RETRYABLE: Record<ErrorCode, boolean> = {
  infeasible: false,
  needs_clarification: true,
  deny_auto: true,            // 手动模式下可继续
  deny_with_override: true,   // 用户提供令牌后可继续
  deny_hard: false,
  unknown_physical_state: false,
  resource_corrupted: true,
  timeout: false,             // 必须只读验证，禁止盲重试
  target_mismatch: false,     // 换设备即换目标，必须重新 plan
};

export class OrchestratorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrchestratorError";
  }

  get retryable(): boolean {
    return RETRYABLE[this.code];
  }

  toJSON(): Record<string, unknown> {
    return { error_code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

// 6.6：用户强行要求快速擦除时返回的警告码
export const WARN_LOGICAL_ERASE_ONLY = "LOGICAL_ERASE_ONLY_DATA_REMAINS_RECOVERABLE";
