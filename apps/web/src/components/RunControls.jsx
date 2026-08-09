import { useState } from 'react';
import { PROFILE, PROFILE_META, DEFAULT_RUN } from '@scalescope/contracts/profiles';

/**
 * The run form.
 *
 * Deliberately a plain controlled form rather than anything clever — this is
 * the one part of the console where a judge's attention should be on the
 * numbers they're choosing, not on the interface choosing them.
 */
export default function RunControls({ onStart, onStop, onSetpoint, running, budget }) {
  const [form, setForm] = useState({ ...DEFAULT_RUN, name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onStart({
        ...form,
        rounds: Number(form.rounds),
        maxConcurrency: Number(form.maxConcurrency),
        durationS: Number(form.durationS),
        cooldownS: Number(form.cooldownS),
        sloP95Ms: Number(form.sloP95Ms),
        setpointMs: Number(form.setpointMs),
      });
    } catch (err) {
      setError(err.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const budgetExhausted = budget && budget.remaining <= 0;

  return (
    <form className="run-controls" onSubmit={submit}>
      <div className="field">
        <label>Profile</label>
        <select value={form.profile} onChange={set('profile')} disabled={running}>
          {Object.values(PROFILE).map((p) => (
            <option key={p} value={p}>{PROFILE_META[p].label}</option>
          ))}
        </select>
        <p className="field-hint">{PROFILE_META[form.profile]?.teaches}</p>
      </div>

      <div className="run-controls-grid">
        <div className="field">
          <label>Max concurrency</label>
          <input type="number" min="1" max="200" value={form.maxConcurrency} onChange={set('maxConcurrency')} disabled={running} />
        </div>
        <div className="field">
          <label>Rounds (CPU cost)</label>
          <input type="number" min="1000" max="60000" step="1000" value={form.rounds} onChange={set('rounds')} disabled={running} />
        </div>
        <div className="field">
          <label>Duration (s)</label>
          <input type="number" min="5" max="180" value={form.durationS} onChange={set('durationS')} disabled={running} />
        </div>
        <div className="field">
          <label>Cooldown (s)</label>
          <input type="number" min="0" max="180" value={form.cooldownS} onChange={set('cooldownS')} disabled={running} />
        </div>
        <div className="field">
          <label>SLO p95 (ms)</label>
          <input type="number" min="1" value={form.sloP95Ms} onChange={set('sloP95Ms')} disabled={running} />
        </div>
        {form.profile === PROFILE.AUTOPILOT && (
          <div className="field">
            <label>Setpoint (ms)</label>
            <input type="number" min="1" value={form.setpointMs} onChange={set('setpointMs')} />
          </div>
        )}
      </div>

      {error && <p className="run-controls-error">{error}</p>}

      <div className="run-controls-actions">
        {!running ? (
          <button className="btn btn-primary" type="submit" disabled={busy || budgetExhausted}>
            {busy ? 'starting…' : budgetExhausted ? 'budget exhausted' : 'start run'}
          </button>
        ) : (
          <>
            <button className="btn btn-danger" type="button" onClick={onStop}>stop run</button>
            {form.profile === PROFILE.AUTOPILOT && (
              <button
                className="btn"
                type="button"
                onClick={() => onSetpoint(Number(form.setpointMs))}
              >
                apply setpoint
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
