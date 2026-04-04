// client/src/components/AgentProgress.jsx

const STEP_ICONS = {
  schema: '🧠',
  schema_done: '🧠',
  planning: '📋',
  planning_done: '📋',
  searching: '🔍',
  searching_done: '🔍',
  scraping: '📄',
  scraping_done: '📄',
  extracting: '⚙️',
  extracting_done: '⚙️',
  merging: '🔗',
  complete: '✅'
};

export function AgentProgress({ steps }) {
  if (steps.length === 0) return null;

  const lastStep = steps[steps.length - 1];
  const isComplete = lastStep.step === 'complete';

  return (
    <section className="panel progress-panel">
      <h3 className="progress-title">
        {isComplete ? 'Search complete' : 'Agent working...'}
      </h3>
      <ul className="step-list">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          return (
            <li
              key={index}
              className={`step-item ${isLast && !isComplete ? 'step-active' : 'step-done'}`}
            >
              <span className="step-icon">
                {STEP_ICONS[step.step] || '▸'}
              </span>
              <span className="step-message">{step.message}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}