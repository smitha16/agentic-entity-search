function Cell({ cell }) {
  if (!cell) {
    return <span className="muted">-</span>;
  }

  return (
    <div className="cell-block">
      <div className="cell-value">{cell.value}</div>
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
    </div>
  );
}

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
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.entity_id}>
                {data.columns.map((column) => (
                  <td key={column}>
                    <Cell cell={row.cells[column]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
