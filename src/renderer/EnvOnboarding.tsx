import type { HealthReport } from './api.js';
import { HealthList } from './HealthList.js';
import { COPY } from './copy.js';

/** 首次启动环境体检引导页（B8：仅首次启动时出现，之后仅检测到问题时出现在工作台待我处理）。 */
export function EnvOnboarding({
  env,
  notice,
  error,
  onRefresh,
  onContinue,
}: {
  env: HealthReport | null;
  notice: string | null;
  error: string | null;
  onRefresh: () => void;
  onContinue: () => void;
}) {
  return (
    <main className="main" data-testid="env-onboarding" aria-label={COPY.onboardingTitle}>
      <div className="row sb">
        <div>
          <h1>{COPY.onboardingTitle}</h1>
          <p className="lede">{COPY.onboardingSubtitle}</p>
        </div>
        <button type="button" data-testid="onboarding-continue" onClick={onContinue}>
          {COPY.onboardingContinue}
        </button>
      </div>
      {error && <p role="alert" className="error" data-testid="app-error">{error}</p>}
      {notice && <p role="status" className="notice" data-testid="notice">{notice}</p>}
      <section className="box">
        <HealthList env={env} primaryRefresh={false} onRefresh={onRefresh} />
      </section>
    </main>
  );
}
