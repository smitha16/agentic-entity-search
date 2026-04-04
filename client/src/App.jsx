// Root application component. Renders the search form, streams pipeline
// progress events from the server, and displays the results table.

import { useState } from 'react';

import { searchEntitiesStream } from './lib/api.js';
import { ResultsTable } from './components/ResultsTable.jsx';
import { AgentProgress } from './components/AgentProgress.jsx';

const sampleTopics = [
  'AI startups in healthcare',
  'top pizza places in Brooklyn',
  'open source database tools'
];

export default function App() {
  const [topic, setTopic] = useState(sampleTopics[0]);
  const [steps, setSteps] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Submits the search topic and streams real-time pipeline events.
  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setData(null);
    setSteps([]);    // Clear previous steps

    try {
      await searchEntitiesStream(
        { topic, maxEntities: 10 },
        {
          onStep(stepEvent) {
            // Each step event appends to the list
            setSteps((prev) => [...prev, stepEvent]);
          },
          onResult(result) {
            setData(result);
          },
          onError(err) {
            setError(err.message);
          }
        }
      );
    } catch (requestError) {
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
              <button
                key={sample}
                type="button"
                className="ghost-button"
                onClick={() => setTopic(sample)}
              >
                {sample}
              </button>
            ))}
          </div>
        </form>
      </section>

      {/* Show live progress while searching */}
      {loading && steps.length > 0 && <AgentProgress steps={steps} />}

      {error ? <section className="panel error-panel">{error}</section> : null}
      {data ? <ResultsTable data={data} /> : null}
    </main>
  );
}