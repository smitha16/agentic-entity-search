import { useState } from 'react';

import { searchEntities } from './lib/api.js';
import { ResultsTable } from './components/ResultsTable.jsx';

const sampleTopics = [
  'AI startups in healthcare',
  'top pizza places in Brooklyn',
  'open source database tools'
];

export default function App() {
  const [topic, setTopic] = useState(sampleTopics[0]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await searchEntities({ topic, maxEntities: 10 });
      setData(result);
    } catch (requestError) {
      setData(null);
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Agentic Search Challenge</p>
        <h1>Discover entities from the web with traceable source evidence.</h1>
        {/* <p className="hero-copy">
          Enter a topic query and the app will search the web, process pages, extract entities, and return a
          structured table where every value is tied back to its source.
        </p> */}
      </section>

      <section className="panel">
        <form className="search-form" onSubmit={handleSubmit}>
          <label htmlFor="topic">Topic query</label>
          <div className="search-row">
            <input
              id="topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="e.g. AI startups in healthcare"
            />
            <button disabled={loading} type="submit">
              {loading ? 'Searching...' : 'Run search'}
            </button>
          </div>
          <div className="sample-row">
            {sampleTopics.map((sample) => (
              <button key={sample} type="button" className="ghost-button" onClick={() => setTopic(sample)}>
                {sample}
              </button>
            ))}
          </div>
        </form>
      </section>

      {error ? <section className="panel error-panel">{error}</section> : null}
      {data ? <ResultsTable data={data} /> : null}
    </main>
  );
}
