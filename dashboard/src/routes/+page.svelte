<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { DashboardSnapshot, JobEvent, ModelStatus, ProcessStatus, ServiceStatus } from '$lib/types.js';

  type DashboardSection = 'overview' | 'agents' | 'repos' | 'runs' | 'logs';

  export let data: PageData;

  let snapshot: DashboardSnapshot = data.snapshot;
  let selectedRepo = 'all';
  let refreshError: string | null = null;
  let refreshing = false;
  let currentSection: DashboardSection = 'overview';
  let showEmptyCycles = false;

  const navItems: Array<{ id: DashboardSection; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Agents' },
    { id: 'repos', label: 'Repos' },
    { id: 'runs', label: 'Runs' },
    { id: 'logs', label: 'Logs' }
  ];

  $: repoOptions = snapshot.reviewers.map((reviewer) => reviewer.repo);
  $: selectedJobs = selectedRepo === 'all'
    ? snapshot.jobs
    : snapshot.jobs.filter((job) => job.repo === selectedRepo);
  $: emptyCycleCount = selectedJobs.filter(isEmptyCycle).length;
  $: visibleJobs = showEmptyCycles ? selectedJobs : selectedJobs.filter((job) => !isEmptyCycle(job));
  $: jobCounts = {
    review: selectedJobs.filter((job) => job.job === 'review').length,
    learn: selectedJobs.filter((job) => job.job === 'learn').length,
    decay: selectedJobs.filter((job) => job.job === 'decay').length
  };
  $: lastJob = snapshot.jobs[0] ?? null;
  $: healthTone = snapshot.counts.servicesActive === snapshot.counts.servicesTotal ? 'good' : 'bad';
  $: recentReviewed = selectedRepo === 'all' ? snapshot.counts.reviewed : sumResult(selectedJobs, 'reviewed');
  $: recentSkipped = selectedRepo === 'all' ? snapshot.counts.skipped : sumResult(selectedJobs, 'skipped');
  $: activeModels = snapshot.models.filter((model) => model.enabled).length;
  $: probedModels = snapshot.models.filter((model) => model.enabled && model.probe.state === 'ok').length;
  $: failedModel = snapshot.models.find((model) => model.enabled && model.probe.state === 'failed');

  onMount(() => {
    const updateFromHash = () => {
      const hashSection = window.location.hash.replace(/^#/, '');
      if (navItems.some((item) => item.id === hashSection)) {
        currentSection = hashSection as DashboardSection;
      }
    };

    updateFromHash();
    window.addEventListener('hashchange', updateFromHash);

    const id = window.setInterval(() => {
      void refreshSnapshot(false);
    }, 5_000);

    return () => {
      window.clearInterval(id);
      window.removeEventListener('hashchange', updateFromHash);
    };
  });

  async function refreshSnapshot(showSpinner = true) {
    if (typeof window === 'undefined') return;
    if (showSpinner) refreshing = true;
    try {
      const response = await window.fetch('/api/snapshot');
      if (!response.ok) throw new Error(`snapshot ${response.status}`);
      snapshot = await response.json() as DashboardSnapshot;
      refreshError = null;
    } catch (err) {
      refreshError = err instanceof Error ? err.message : String(err);
    } finally {
      refreshing = false;
    }
  }

  function sumResult(jobs: JobEvent[], key: string): number {
    return jobs.reduce((total, job) => {
      const value = job.result?.[key];
      return total + (typeof value === 'number' ? value : 0);
    }, 0);
  }

  function isEmptyCycle(job: JobEvent): boolean {
    if (job.status !== 'ok' || !job.result) return false;
    const reviewed = typeof job.result.reviewed === 'number' ? job.result.reviewed : 0;
    const skipped = typeof job.result.skipped === 'number' ? job.result.skipped : 0;
    const curated = typeof job.result.curated === 'number' ? job.result.curated : 0;
    const seen = typeof job.result.seen === 'number' ? job.result.seen : 0;
    const noisyFlags = job.result.initialized || job.result.limited || job.result.deleted || job.result.decayed;
    return !noisyFlags && reviewed === 0 && skipped === 0 && curated === 0 && seen === 0;
  }

  function formatTime(value: string | null | undefined): string {
    if (!value) return 'unknown';
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return value.replace(/^Thu\s+/, '').replace(/\s+IDT$/, '');
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(parsed);
  }

  function timeAgo(value: string | null | undefined): string {
    if (!value) return 'unknown';
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return 'live';
    const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function serviceTone(service: ServiceStatus): 'good' | 'warn' | 'bad' {
    if (service.activeState === 'active' && (service.subState === 'running' || service.subState === 'waiting')) return 'good';
    if (service.activeState === 'activating' || service.activeState === 'reloading') return 'warn';
    return 'bad';
  }

  function jobTone(job: JobEvent): 'good' | 'warn' | 'bad' {
    if (job.status === 'failed') return 'bad';
    if (typeof job.result?.skipped === 'number' && job.result.skipped > 0) return 'warn';
    if (/\blimited\b|\bwarn/i.test(job.summary)) return 'warn';
    return 'good';
  }

  function modelTone(model: ModelStatus): 'good' | 'warn' | 'bad' {
    if (!model.enabled) return 'warn';
    if (model.probe.state === 'failed') return 'bad';
    if (model.probe.state === 'unknown') return 'warn';
    return 'good';
  }

  function probeTone(model: ModelStatus): 'good' | 'warn' | 'bad' {
    if (model.probe.state === 'ok') return 'good';
    if (model.probe.state === 'failed') return 'bad';
    return 'warn';
  }

  function probeLabel(model: ModelStatus): string {
    if (model.probe.state === 'ok') return `live ${model.probe.ms ?? '?'}ms`;
    if (model.probe.state === 'failed') return 'probe failed';
    if (model.probe.state === 'disabled') return 'disabled';
    return 'probe pending';
  }

  function authLabel(model: ModelStatus): string {
    return model.auth === model.effectiveAuth ? model.auth : `${model.auth} -> ${model.effectiveAuth}`;
  }

  function probeDetail(model: ModelStatus): string {
    if (model.probe.state === 'ok') {
      const responseModel = model.probe.responseModel ? ` / provider model ${model.probe.responseModel}` : '';
      const responseId = model.probe.responseId ? ` / response ${model.probe.responseId}` : '';
      const shared = model.probe.sharedRoles.length > 1 ? ` / shared by ${model.probe.sharedRoles.join(', ')}` : '';
      return `${model.probe.kind} probe checked ${timeAgo(model.probe.checkedAt)}${responseModel}${responseId}${shared}`;
    }
    if (model.probe.state === 'failed') return model.probe.error ?? 'probe failed';
    if (model.probe.state === 'disabled') return 'No embedder configured.';
    return 'Probe has not completed yet.';
  }

  function commandLabel(process: ProcessStatus): string {
    return process.command
      .replace('/home/avifenesh/.nvm/versions/node/v25.9.0/bin/', '')
      .replace('/home/avifenesh/projects/revuto/', '')
      .slice(0, 140);
  }

  function selectSection(section: DashboardSection) {
    currentSection = section;
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
</script>

<svelte:head>
  <title>Revuto Watch</title>
  <meta name="description" content="Local Revuto observability dashboard" />
</svelte:head>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark">R</span>
      <div>
        <strong>Revuto</strong>
        <span>Watch v0.1</span>
      </div>
    </div>

    <nav aria-label="Dashboard views">
      {#each navItems as item}
        <button
          type="button"
          class:active={currentSection === item.id}
          aria-pressed={currentSection === item.id}
          onclick={() => selectSection(item.id)}
        >
          {item.label}
        </button>
      {/each}
    </nav>

    <div class="side-block">
      <span class="eyebrow">Mode</span>
      <strong>Observe only</strong>
      <p>Stop, rerun, and steer are parked for the next slice.</p>
    </div>
  </aside>

  <main class="workspace">
    <header class="topbar">
      <div>
        <h1>Revuto Watch</h1>
        <p>
          {snapshot.configPath ?? snapshot.vaultPath ?? 'Config unavailable'}
          {#if snapshot.store}
            <span>/</span> {snapshot.store.backend}:{snapshot.store.namespace}
          {/if}
        </p>
      </div>

      <div class="top-actions">
        <span class:good={healthTone === 'good'} class:bad={healthTone === 'bad'} class="status-chip">
          {snapshot.counts.servicesActive}/{snapshot.counts.servicesTotal} units active
        </span>
        <span class="status-chip neutral">Refreshed {timeAgo(snapshot.generatedAt)}</span>
        <button class="refresh" type="button" onclick={() => refreshSnapshot()} disabled={refreshing}>
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </header>

    {#if refreshError || snapshot.configError}
      <section class="notice" aria-live="polite">
        {refreshError ?? snapshot.configError}
      </section>
    {/if}

    <section
      class="metrics"
      id="overview"
      aria-label="Overview metrics"
      hidden={currentSection !== 'overview'}
    >
      <div class="metric">
        <span>Registered repos</span>
        <strong>{snapshot.counts.reviewers}</strong>
        <small>{snapshot.counts.pausedReviewers} paused</small>
      </div>
      <div class="metric">
        <span>Model probes</span>
        <strong>{probedModels}/{activeModels}</strong>
        <small>{failedModel ? `${failedModel.role} failed` : `${snapshot.models.length} roles configured`}</small>
      </div>
      <div class="metric">
        <span>Recent reviews</span>
        <strong>{recentReviewed}</strong>
        <small>{recentSkipped} skipped</small>
      </div>
      <div class="metric">
        <span>Recent failures</span>
        <strong>{snapshot.counts.recentFailures}</strong>
        <small>{snapshot.counts.recentJobs} jobs scanned</small>
      </div>
      <div class="metric wide">
        <span>Last job</span>
        <strong>{lastJob ? `${lastJob.job} ${lastJob.repo}` : 'No jobs'}</strong>
        <small>{lastJob ? `${timeAgo(lastJob.timestamp)} / ${lastJob.summary}` : 'Waiting for daemon activity'}</small>
      </div>
    </section>

    <section class="control-strip" aria-label="Read-only agent controls" hidden={currentSection !== 'overview'}>
      <button type="button" disabled>Stop</button>
      <button type="button" disabled>Rerun</button>
      <button type="button" disabled>Steer</button>
      <span>Read-only surface</span>
    </section>

    <div class={`grid view-${currentSection}`} hidden={currentSection === 'repos' || currentSection === 'logs'}>
      <section class="panel service-panel" aria-labelledby="service-title" hidden={currentSection !== 'overview'}>
        <div class="panel-header">
          <div>
            <h2 id="service-title">Service Health</h2>
            <p>systemd user units</p>
          </div>
        </div>

        <div class="service-list">
          {#each snapshot.services as service}
            <article class="service-row">
              <div class="row-main">
                <span
                  class:good={serviceTone(service) === 'good'}
                  class:warn={serviceTone(service) === 'warn'}
                  class:bad={serviceTone(service) === 'bad'}
                  class="dot"
                ></span>
                <div>
                  <h3>{service.label}</h3>
                  <p>{service.id}</p>
                </div>
              </div>
              <div class="row-meta">
                <strong>{service.activeState}</strong>
                <span>{service.subState}</span>
                {#if service.mainPid}
                  <span>pid {service.mainPid}</span>
                {/if}
                <span>{service.kind === 'timer' ? `last ${formatTime(service.lastTrigger)}` : `since ${formatTime(service.since)}`}</span>
              </div>
            </article>
          {/each}
        </div>
      </section>

      <section
        class="panel run-panel"
        id="runs"
        aria-labelledby="run-title"
        hidden={currentSection !== 'overview' && currentSection !== 'runs'}
      >
        <div class="panel-header">
          <div>
            <h2 id="run-title">Run Timeline</h2>
            <p>recent daemon journal events</p>
          </div>
          <div class="job-mix" aria-label="Job mix in current run window">
            <span>review {jobCounts.review}</span>
            <span>learn {jobCounts.learn}</span>
            <span>decay {jobCounts.decay}</span>
          </div>
          <label>
            <span>Repo</span>
            <select bind:value={selectedRepo}>
              <option value="all">All repos</option>
              {#each repoOptions as repo}
                <option value={repo}>{repo}</option>
              {/each}
            </select>
          </label>
          <label class="toggle">
            <input type="checkbox" bind:checked={showEmptyCycles} />
            <span>Show empty cycles{emptyCycleCount > 0 ? ` (${emptyCycleCount})` : ''}</span>
          </label>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Repo</th>
                <th>Job</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleJobs.slice(0, 80) as job}
                <tr>
                  <td>{formatTime(job.timestamp)}</td>
                  <td class="mono repo-cell">{job.repo}</td>
                  <td>{job.job}</td>
                  <td>
                    <span
                      class:good={jobTone(job) === 'good'}
                      class:warn={jobTone(job) === 'warn'}
                      class:bad={jobTone(job) === 'bad'}
                      class="status-pill"
                    >
                      {job.status}
                    </span>
                  </td>
                  <td>{job.durationMs === null ? '-' : `${job.durationMs}ms`}</td>
                  <td>{job.summary}</td>
                </tr>
              {:else}
                <tr>
                  <td colspan="6" class="empty">
                    {emptyCycleCount > 0
                      ? `No activity — ${emptyCycleCount} empty poll ${emptyCycleCount === 1 ? 'cycle' : 'cycles'} hidden.`
                      : 'No daemon jobs in the current window.'}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section
        class="panel right-rail"
        id="agents"
        aria-labelledby="agents-title"
        hidden={currentSection !== 'overview' && currentSection !== 'agents'}
      >
        <div class="panel-header">
          <div>
            <h2 id="agents-title">Agents</h2>
            <p>model specs and local processes</p>
          </div>
        </div>

        <div class="model-list">
          {#each snapshot.models as model}
            <article class="model-row">
              <div class="model-head">
                <div class="model-role">
                  <span
                    class:good={modelTone(model) === 'good'}
                    class:warn={modelTone(model) === 'warn'}
                    class:bad={modelTone(model) === 'bad'}
                    class="dot"
                  ></span>
                  <strong>{model.role}</strong>
                </div>
                <span
                  class:good={probeTone(model) === 'good'}
                  class:warn={probeTone(model) === 'warn'}
                  class:bad={probeTone(model) === 'bad'}
                  class="status-pill"
                >
                  {probeLabel(model)}
                </span>
              </div>
              <p class="model-name">{model.model}</p>
              <div class="model-meta">
                <span><b>API</b>{model.api}</span>
                <span><b>Auth</b>{authLabel(model)}</span>
                <span><b>Effort</b>{model.reasoningEffort ?? 'none'}</span>
                <span><b>Provider</b>{model.name}</span>
                {#if model.probe.responseModel}
                  <span><b>Live</b>{model.probe.responseModel}</span>
                {/if}
              </div>
              <small class="endpoint">{model.baseURL}</small>
              <small class="probe-detail">{probeDetail(model)}</small>
              {#if model.authDetail}
                <small class="probe-detail">{model.authDetail}</small>
              {/if}
            </article>
          {/each}
        </div>

        <div class="subsection">
          <h3>Processes</h3>
          <div class="process-list">
            {#each snapshot.processes.slice(0, 8) as process}
              <div class="process-row">
                <span class="mono">{process.pid}</span>
                <strong>{process.cpu.toFixed(1)}%</strong>
                <p>{commandLabel(process)}</p>
              </div>
            {:else}
              <p class="empty compact">No matching local processes.</p>
            {/each}
          </div>
        </div>
      </section>
    </div>

    <section
      class="panel repos-panel"
      id="repos"
      aria-labelledby="repos-title"
      hidden={currentSection !== 'repos'}
    >
      <div class="panel-header">
        <div>
          <h2 id="repos-title">Registered Repos</h2>
          <p>effective schedules from the vault</p>
        </div>
        {#if snapshot.schedules}
          <span class="status-chip neutral">review {snapshot.schedules.review}</span>
        {/if}
      </div>

      <div class="repo-grid">
        {#each snapshot.reviewers as reviewer}
          <article class="repo-row">
            <div>
              <strong>{reviewer.repo}</strong>
              <span>{reviewer.botLogin ?? 'bot unknown'}</span>
            </div>
            <div>
              <span>{reviewer.paused ? 'paused' : 'active'}</span>
              <span>review {reviewer.schedules.review}</span>
              <span>learn {reviewer.schedules.learn}</span>
            </div>
          </article>
        {/each}
      </div>
    </section>

    <section
      class="panel logs-panel"
      id="logs"
      aria-labelledby="logs-title"
      hidden={currentSection !== 'logs'}
    >
      <div class="panel-header">
        <div>
          <h2 id="logs-title">Daemon Logs</h2>
          <p>latest journal lines</p>
        </div>
      </div>

      <div class="log-stream" aria-live="polite">
        {#each snapshot.logs.slice(0, 70) as log}
          <div class:error={log.level === 'error'} class:warn={log.level === 'warn'} class="log-row">
            <span>{formatTime(log.timestamp)}</span>
            <code>{log.message}</code>
          </div>
        {/each}
      </div>
    </section>
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: 224px minmax(0, 1fr);
    min-height: 100vh;
    background:
      linear-gradient(180deg, rgba(37, 99, 235, 0.04), transparent 260px),
      #f5f7f8;
  }

  .sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 28px;
    height: 100vh;
    padding: 18px 14px;
    border-right: 1px solid #dbe2e7;
    background: #ffffff;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 6px 4px;
  }

  .brand-mark {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 1px solid #174f55;
    border-radius: 8px;
    background: #0d3439;
    color: #d8fff8;
    font-weight: 800;
  }

  .brand strong,
  .brand span {
    display: block;
  }

  .brand strong {
    font-size: 15px;
    line-height: 1.2;
  }

  .brand div span {
    color: #65737c;
    font-size: 12px;
    line-height: 1.4;
  }

  nav {
    display: grid;
    gap: 4px;
  }

  nav button {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 34px;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #43515a;
    font-size: 13px;
    font-weight: 650;
    line-height: 1.25;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  nav button:hover,
  nav button.active {
    background: #edf4f4;
    color: #0d3439;
  }

  nav button:focus-visible {
    outline: 2px solid #5bb6a6;
    outline-offset: 2px;
  }

  .side-block {
    margin-top: auto;
    padding: 12px;
    border: 1px solid #dbe2e7;
    border-radius: 8px;
    background: #f8fafb;
  }

  .side-block .eyebrow,
  .metric span,
  .panel-header p,
  label span {
    color: #6d7a83;
    font-size: 11px;
    font-weight: 760;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .side-block strong {
    display: block;
    margin-top: 4px;
    font-size: 14px;
  }

  .side-block p {
    margin: 8px 0 0;
    color: #65737c;
    font-size: 12px;
    line-height: 1.45;
  }

  .workspace {
    display: grid;
    gap: 14px;
    min-width: 0;
    padding: 18px;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 56px;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    color: #11191e;
    font-size: 24px;
    font-weight: 760;
    line-height: 1.15;
  }

  .topbar p {
    margin-top: 5px;
    color: #596872;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .topbar p span {
    color: #98a4ab;
    padding: 0 6px;
  }

  .top-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  .status-chip,
  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 5px 8px;
    border: 1px solid #d9e2e6;
    border-radius: 6px;
    background: #ffffff;
    color: #42515a;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .status-pill {
    min-height: 24px;
    padding: 3px 7px;
    font-size: 11px;
  }

  .good {
    border-color: #a8d8cd;
    background: #edf9f5;
    color: #105047;
  }

  .warn {
    border-color: #f3d39b;
    background: #fff8ea;
    color: #7a4b08;
  }

  .bad {
    border-color: #efb8b8;
    background: #fff1f1;
    color: #8a2222;
  }

  .neutral {
    background: #f9fbfc;
  }

  .refresh,
  .control-strip button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 6px 10px;
    border: 1px solid #cdd8de;
    border-radius: 6px;
    background: #ffffff;
    color: #1d2a31;
    font-size: 12px;
    font-weight: 760;
    cursor: pointer;
  }

  .refresh:disabled,
  .control-strip button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .notice {
    padding: 10px 12px;
    border: 1px solid #efb8b8;
    border-radius: 8px;
    background: #fff7f7;
    color: #842626;
    font-size: 13px;
  }

  [hidden] {
    display: none !important;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 10px;
  }

  .metric,
  .panel {
    border: 1px solid #dbe2e7;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 10px 26px rgba(26, 40, 49, 0.05);
  }

  .metric {
    grid-column: span 2;
    min-width: 0;
    min-height: 86px;
    padding: 13px;
  }

  .metric.wide {
    grid-column: span 4;
  }

  .metric strong {
    display: block;
    overflow: hidden;
    margin-top: 8px;
    color: #11191e;
    font-size: 24px;
    font-weight: 780;
    line-height: 1.05;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric small {
    display: block;
    overflow: hidden;
    margin-top: 8px;
    color: #65737c;
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric.wide strong,
  .metric.wide small {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .control-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 6px;
    border: 1px solid #dbe2e7;
    border-radius: 8px;
    background: #ffffff;
  }

  .control-strip span:last-child {
    margin-left: auto;
    padding: 0 8px;
    color: #6d7a83;
    font-size: 12px;
    font-weight: 700;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(300px, 0.82fr) minmax(0, 1.18fr);
    grid-template-areas:
      'runs runs'
      'service agents';
    gap: 14px;
    align-items: start;
  }

  .service-panel {
    grid-area: service;
  }

  .run-panel {
    grid-area: runs;
  }

  .right-rail {
    grid-area: agents;
  }

  .grid.view-runs,
  .grid.view-agents {
    grid-template-columns: minmax(0, 1fr);
  }

  .grid.view-runs {
    grid-template-areas: 'runs';
  }

  .grid.view-agents {
    grid-template-areas: 'agents';
  }

  .panel {
    min-width: 0;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 58px;
    padding: 14px;
    border-bottom: 1px solid #e2e8ec;
  }

  h2 {
    color: #142027;
    font-size: 15px;
    font-weight: 780;
    line-height: 1.25;
  }

  .panel-header p {
    margin-top: 4px;
  }

  .job-mix {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    margin-left: auto;
  }

  .job-mix span {
    min-height: 24px;
    padding: 4px 7px;
    border: 1px solid #dbe2e7;
    border-radius: 6px;
    background: #f8fafb;
    color: #4d5c65;
    font-size: 11px;
    font-weight: 720;
    white-space: nowrap;
  }

  label {
    display: grid;
    gap: 4px;
    min-width: 180px;
  }

  label.toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  label.toggle input {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: #0d3439;
    cursor: pointer;
  }

  label.toggle span {
    color: #4d5c65;
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
  }

  select {
    width: 100%;
    min-height: 32px;
    padding: 5px 30px 5px 8px;
    border: 1px solid #cdd8de;
    border-radius: 6px;
    background: #ffffff;
    color: #24333b;
    font-size: 12px;
    font-weight: 650;
  }

  .service-list,
  .model-list,
  .process-list {
    display: grid;
  }

  .service-row,
  .model-row,
  .repo-row {
    border-bottom: 1px solid #edf1f3;
  }

  .service-row {
    display: grid;
    gap: 12px;
    padding: 13px 14px;
  }

  .row-main,
  .model-role {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .dot {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border: 1px solid currentColor;
    border-radius: 50%;
    background: currentColor;
  }

  .row-main h3 {
    overflow: hidden;
    color: #17242b;
    font-size: 13px;
    font-weight: 760;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-main p,
  .row-meta,
  .model-row p,
  .model-row small,
  .repo-row span {
    color: #65737c;
    font-size: 12px;
    line-height: 1.35;
  }

  .row-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px 10px;
  }

  .row-meta strong {
    color: #1f2d34;
  }

  .table-wrap {
    max-height: 530px;
    overflow: auto;
  }

  table {
    width: 100%;
    min-width: 760px;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th,
  td {
    min-height: 38px;
    padding: 9px 10px;
    border-bottom: 1px solid #edf1f3;
    color: #2c3b43;
    font-size: 12px;
    line-height: 1.35;
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #f7fafb;
    color: #63717a;
    font-size: 11px;
    font-weight: 780;
    text-transform: uppercase;
  }

  th:nth-child(1),
  td:nth-child(1) {
    width: 76px;
  }

  th:nth-child(3),
  td:nth-child(3),
  th:nth-child(4),
  td:nth-child(4),
  th:nth-child(5),
  td:nth-child(5) {
    width: 80px;
  }

  .repo-cell {
    overflow: hidden;
    color: #24333b;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    color: #7a8790;
    font-style: italic;
  }

  .compact {
    padding: 12px 14px;
    font-size: 12px;
  }

  .model-row {
    display: grid;
    gap: 7px;
    padding: 12px 14px;
  }

  .model-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }

  .model-role {
    overflow: hidden;
  }

  .model-row strong {
    color: #152229;
    font-size: 13px;
    font-weight: 780;
    text-transform: capitalize;
  }

  .model-name {
    overflow: hidden;
    color: #22323a;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px;
  }

  .model-meta span {
    min-width: 0;
    padding: 6px 7px;
    border: 1px solid #e2e8ec;
    border-radius: 6px;
    background: #f9fbfc;
    color: #2e3f48;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .model-meta b {
    display: block;
    margin-bottom: 2px;
    color: #75828a;
    font-size: 10px;
    font-weight: 780;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .endpoint,
  .probe-detail {
    overflow-wrap: anywhere;
  }

  .endpoint {
    color: #42525b;
  }

  .probe-detail {
    color: #6b7a83;
  }

  .subsection {
    padding-top: 12px;
  }

  .subsection h3 {
    padding: 0 14px 8px;
    color: #4c5b64;
    font-size: 11px;
    font-weight: 780;
    text-transform: uppercase;
  }

  .process-row {
    display: grid;
    grid-template-columns: 56px 48px minmax(0, 1fr);
    gap: 8px;
    padding: 9px 14px;
    border-top: 1px solid #edf1f3;
    align-items: start;
  }

  .process-row span,
  .process-row strong {
    color: #26363f;
    font-size: 12px;
  }

  .process-row p {
    display: -webkit-box;
    overflow: hidden;
    color: #65737c;
    font-size: 12px;
    line-height: 1.35;
    overflow-wrap: anywhere;
    text-overflow: ellipsis;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .repos-panel,
  .logs-panel {
    align-self: stretch;
  }

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .repo-row {
    display: grid;
    gap: 10px;
    min-height: 82px;
    padding: 12px 14px;
    border-right: 1px solid #edf1f3;
  }

  .repo-row strong {
    display: block;
    overflow: hidden;
    color: #17242b;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-row div:last-child {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .repo-row div:last-child span {
    padding: 3px 6px;
    border: 1px solid #dbe2e7;
    border-radius: 5px;
    background: #f8fafb;
    color: #4d5c65;
    font-weight: 650;
  }

  .log-stream {
    display: grid;
    max-height: 280px;
    overflow: auto;
    background: #10171b;
  }

  .log-row {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    padding: 7px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    color: #d8e1e6;
  }

  .log-row span {
    color: #8aa2ad;
    font-size: 11px;
    line-height: 1.5;
  }

  .log-row code {
    overflow-wrap: anywhere;
    color: #dce8ec;
    font-size: 11px;
    line-height: 1.55;
  }

  .log-row.warn code {
    color: #ffe2aa;
  }

  .log-row.error code {
    color: #ffc7c7;
  }

  @media (max-width: 1280px) {
    .shell {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      height: auto;
      padding: 12px 14px;
    }

    nav {
      grid-auto-flow: column;
      justify-content: start;
      overflow-x: auto;
    }

    .side-block {
      margin-top: 0;
      width: 190px;
    }

    .metrics,
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric {
      grid-column: auto;
    }

    .metric.wide {
      grid-column: 1 / -1;
    }

    .grid {
      grid-template-areas:
        'runs runs'
        'service agents';
    }

    .repo-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 900px) {
    .grid {
      grid-template-columns: 1fr;
      grid-template-areas:
        'runs'
        'service'
        'agents';
    }
  }

  @media (max-width: 760px) {
    .workspace {
      padding: 12px;
    }

    .topbar,
    .panel-header {
      align-items: stretch;
      flex-direction: column;
    }

    .top-actions {
      justify-content: flex-start;
    }

    .job-mix {
      margin-left: 0;
    }

    .sidebar {
      grid-template-columns: 1fr;
      gap: 18px;
    }

    .side-block {
      display: none;
    }

    .grid,
    .repo-grid {
      grid-template-columns: 1fr;
    }

    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric.wide {
      grid-column: 1 / -1;
    }

    .control-strip {
      flex-wrap: wrap;
    }

    .control-strip span:last-child {
      width: 100%;
      margin-left: 0;
      padding: 4px;
    }

    .table-wrap {
      max-height: 420px;
    }

    table {
      min-width: 540px;
    }

    th,
    td {
      padding: 8px;
    }

    th:nth-child(5),
    td:nth-child(5),
    th:nth-child(6),
    td:nth-child(6) {
      display: none;
    }

    .log-row {
      grid-template-columns: 70px minmax(0, 1fr);
    }
  }
</style>
