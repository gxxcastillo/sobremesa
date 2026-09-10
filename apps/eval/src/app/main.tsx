import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { Router, Route, A } from '@solidjs/router';
import { NewRun } from './pages/NewRun';
import { RunHistory } from './pages/RunHistory';
import { RunResult } from './pages/RunResult';
import { MessageTrace, currentTraceFamilyId } from './pages/MessageTrace';
import { FamilyCompare } from './pages/FamilyCompare';
import { ImportVerification } from './pages/ImportVerification';
import { ConnectionBanner } from './components/ConnectionBanner';
import './styles.css';

function Shell(props: { children?: JSX.Element }) {
  return (
    <div class="shell">
      <ConnectionBanner />
      <header class="shell-header">
        <h1>Sobremesa Eval</h1>
        <nav>
          <A href="/" end>
            New Run
          </A>
          <A href="/history">History</A>
          <A
            href={
              currentTraceFamilyId()
                ? `/trace/${currentTraceFamilyId()}`
                : '/trace'
            }
          >
            Message Trace
          </A>
          <A href="/compare">Family Compare</A>
          <A href="/import-verification">Import Verification</A>
        </nav>
      </header>
      <main class="shell-main">{props.children}</main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  render(
    () => (
      <Router root={Shell}>
        <Route path="/" component={NewRun} />
        <Route path="/history" component={RunHistory} />
        <Route path="/runs/:id" component={RunResult} />
        <Route path="/trace/:familyId?/:eventId?" component={MessageTrace} />
        <Route path="/compare" component={FamilyCompare} />
        <Route path="/import-verification" component={ImportVerification} />
      </Router>
    ),
    root,
  );
}
