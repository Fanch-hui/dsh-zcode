export async function runCaptchaSolve(_scene: string, _region: string, _prefix: string): Promise<string> {
  throw new Error('VERIFICATION_REQUIRED')
}

export function setCaptchaSolverConcurrency(_count: number): void {}
export function shutdownCaptchaSolver(): void {}
export function captchaSolverConcurrency(): number { return 0 }
