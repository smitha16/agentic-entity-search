// Results table component. Renders extracted entities in a table with
// per-cell source attribution and expandable source details.

// Renders a single table cell value with an expandable sources list.
function Cell({ cell }) {
  if (!cell) {
    return <span className="muted">-</span>;
  }

  return (
    <div className="cell-block">
      <div className="cell-value">{cell.value}</div>
      {cell.sources && cell.sources.length > 0 && (
        <details>
          <summary>Sources ({cell.sources.length})</summary>
          <ul className="source-list">
            {cell.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title || source.url}
                </a>
                <p>{source.snippet}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Badge showing match tier
function MatchBadge({ row }) {
  if (!row.matchTier) return null;

  const badges = {
    full:    { label: 'Full match',    className: 'badge badge-full' },
    partial: { label: 'Partial match', className: 'badge badge-partial' },
    none:    { label: 'No match',      className: 'badge badge-none' }
  };

  const badge = badges[row.matchTier] || null;
  if (!badge) return null;

  return <span className={badge.className}>{badge.label}</span>;
}

// Displays the entity results as a table with metadata (topic, entity type,
// page count, latency) and per-cell source attribution.
export function ResultsTable({ data }) {
  return (
    <section className="panel results-panel">
      <div className="meta-row">
        <div>
          <strong>Topic:</strong> {data.topic}
        </div>
        <div>
          <strong>Entity type:</strong> {data.entityType}
        </div>
        <div>
          <strong>Pages processed:</strong> {data.meta.processedPages}
        </div>
        <div>
          <strong>Latency:</strong> {data.meta.latencyMs} ms
        </div>
        {data.meta.requirementCount > 0 && (
          <div>
            <strong>Requirements:</strong> {data.meta.requirementCount} detected
          </div>
        )}
      </div>

      {/* Show detected requirements if any */}
      {data.requirements && data.requirements.length > 0 && (
        <div className="requirements-bar">
          <strong>Filtering by:</strong>{' '}
          {data.requirements.map((r, i) => (
            <span key={i} className="requirement-tag">{r.description}</span>
          ))}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column}>{column.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => {
              // Detect tier boundaries for visual separation
              const prevTier = rowIndex > 0 ? data.rows[rowIndex - 1].matchTier : null;
              const showDivider = row.matchTier && prevTier && row.matchTier !== prevTier;

              return (
                <>
                  {showDivider && (
                    <tr key={`divider-${rowIndex}`} className="tier-divider">
                      <td colSpan={data.columns.length}>
                        {row.matchTier === 'partial' && '── Partial matches ──'}
                        {row.matchTier === 'none' && '── Also relevant ──'}
                      </td>
                    </tr>
                  )}
                  <tr
                    key={row.entity_id || rowIndex}
                    className={row.matchTier ? `row-${row.matchTier}` : ''}
                  >
                    {data.columns.map((column) => (
                      <td key={column}>
                        {column === 'name' && row.matchTier ? (
                          <div className="cell-block">
                            <div className="cell-value">{row.cells[column]?.value || '-'}</div>
                            <MatchBadge row={row} />
                          </div>
                        ) : (
                          <Cell cell={row.cells[column]} />
                        )}
                      </td>
                    ))}
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}