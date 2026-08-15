import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  ActivityIndicator, RefreshControl, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';

/* ----------------------------------------------------------------------------
 * Mission Control — Expo companion
 * Reuses the live MC REST API (server.py). No backend changes required:
 *   GET  /api/state            -> machines / daemons / tasks / drones / economy
 *   GET  /api/profiles         -> profiles
 *   GET  /api/approvals        -> pending approvals + gates
 *   GET  /api/logs/operator    -> operator activity log
 *   POST /api/task/create      { title, assignee?, body? }
 *   POST /api/dispatch         { max }            (run the kanban worker)
 *   POST /api/approvals/resolve { id, decision:'approve'|'deny', by }
 * Base URL is editable in Settings. Device policy blocks cleartext HTTP, so the
 * default is HTTPS to the LAN IP: https://<lan-host-ip>:8777 (Windows port-forward
 * -> WSL TLS proxy -> MC). If your Windows LAN IP changes, edit it in Settings.
 * ------------------------------------------------------------------------- */

const DEFAULT_BASE = 'https://<lan-host-ip>:8777'; // LAN IP -> Windows fwd -> WSL TLS proxy -> MC (HTTPS)
const POLL_MS = 4000;

export default function App() {
  const [base, setBase] = useState(DEFAULT_BASE);
  const [tab, setTab] = useState('dash');
  const [conn, setConn] = useState({ ok: null, ts: null });

  const api = useCallback(async (path, opts) => {
    const url = base.replace(/\/+$/, '') + path;
    const res = await fetch(url, opts);
    setConn({ ok: res.ok, ts: Date.now() });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return { _raw: txt }; }
  }, [base]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style="light" />
      <View style={styles.topbar}>
        <Text style={styles.brand}>MISSION CONTROL</Text>
        <View style={[styles.dot, conn.ok === null ? styles.dotIdle : conn.ok ? styles.dotOk : styles.dotErr]} />
        <Text style={styles.base}>{base}</Text>
      </View>
      <View style={styles.tabs}>
        {TABS.map(t => (
          <TouchableOpacity key={t.k} style={[styles.tab, tab === t.k && styles.tabOn]} onPress={() => setTab(t.k)}>
            <Text style={[styles.tabTx, tab === t.k && styles.tabTxOn]}>{t.l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.body}>
        {tab === 'dash' && <Dash api={api} />}
        {tab === 'tasks' && <Tasks api={api} />}
        {tab === 'approve' && <Approvals api={api} />}
        {tab === 'logs' && <Logs api={api} />}
        {tab === 'settings' && <Settings base={base} setBase={setBase} />}
      </View>
    </SafeAreaView>
  );
}

const TABS = [
  { k: 'dash', l: 'Dash' },
  { k: 'tasks', l: 'Tasks' },
  { k: 'approve', l: 'Approvals' },
  { k: 'logs', l: 'Logs' },
  { k: 'settings', l: 'Set' },
];

function usePoller(api, path, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await api(path);
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, path]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, ...deps]);

  return { data, err, loading, refreshing, reload: load, setRefreshing };
}

function Dash({ api }) {
  const { data, err, loading, refreshing, reload, setRefreshing } = usePoller(api, '/api/state');
  return (
    <ScrollView
      style={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); reload(); }} />}
    >
      {loading && <Centered><ActivityIndicator /></Centered>}
      {err && <ErrBox msg={err} />}
      {data && (
        <>
          <Section title="MACHINES / TITANS">
            {(data.machines || []).map((m, i) => (
              <Card key={i}>
                <Row k="name" v={m.name} />
                <Row k="host" v={m.host} />
                <Row k="models" v={(m.models || []).join(', ')} />
                <Row k="note" v={m.note} />
              </Card>
            ))}
          </Section>
          <Section title="DAEMONS / LLMs">
            {(data.daemons || []).map((d, i) => (
              <Card key={i}>
                <Row k="model" v={d.model || d.name} />
                <Row k="host" v={d.host} />
                <Row k="status" v={d.status || (d.loaded ? 'loaded' : 'idle')} />
              </Card>
            ))}
          </Section>
          <Section title={`TASKS (${((data.tasks) || []).length})`}>
            {(data.tasks || []).map((t, i) => (
              <Card key={i}>
                <Row k="title" v={t.title} />
                <Row k="status" v={t.status} />
                <Row k="assignee" v={t.assignee || '—'} />
              </Card>
            ))}
          </Section>
          <Section title="DRONES / CRON">
            {(data.drones || []).map((c, i) => (
              <Card key={i}><Row k={c.name} v={c.schedule} /></Card>
            ))}
          </Section>
          <Section title="ECONOMY">
            <Card><Text style={styles.wrap}>{(data.economy || []).join('  ·  ')}</Text></Card>
          </Section>
          {data.error && <Text style={styles.warn}>build error: {data.error}</Text>}
        </>
      )}
    </ScrollView>
  );
}

function Tasks({ api }) {
  const { data, err, loading, refreshing, reload, setRefreshing } = usePoller(api, '/api/state');
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const dispatch = async () => {
    if (!title.trim()) { Alert.alert('Title required'); return; }
    setBusy(true);
    try {
      const c = await api('/api/task/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, assignee: assignee.trim() || undefined, body }),
      });
      if (!c.ok) throw new Error(c.detail || 'create failed');
      const d = await api('/api/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max: 1 }),
      });
      Alert.alert('Dispatched', (d.detail || '').slice(0, 200));
      setTitle(''); setAssignee(''); setBody('');
      setRefreshing(true); reload();
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally { setBusy(false); }
  };

  return (
    <ScrollView style={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); reload(); }} />}>
      <View style={styles.form}>
        <Text style={styles.label}>New task</Text>
        <Input placeholder="title" value={title} onChange={setTitle} />
        <Input placeholder="assignee (profile)" value={assignee} onChange={setAssignee} />
        <Input placeholder="body (optional)" value={body} onChange={setBody} multiline />
        <TouchableOpacity style={styles.btn} disabled={busy} onPress={dispatch}>
          <Text style={styles.btnTx}>{busy ? 'Working…' : 'Create + Dispatch'}</Text>
        </TouchableOpacity>
      </View>
      {loading && <Centered><ActivityIndicator /></Centered>}
      {err && <ErrBox msg={err} />}
      <Section title="BOARD">
        {data && (data.tasks || []).map((t, i) => (
          <Card key={i}>
            <Row k="title" v={t.title} />
            <Row k="status" v={t.status} />
            <Row k="assignee" v={t.assignee || '—'} />
          </Card>
        ))}
        {data && (data.tasks || []).length === 0 && <Text style={styles.muted}>no tasks</Text>}
      </Section>
    </ScrollView>
  );
}

function Approvals({ api }) {
  const { data, err, loading, refreshing, reload, setRefreshing } = usePoller(api, '/api/approvals');
  const resolve = async (id, decision) => {
    try {
      await api('/api/approvals/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, by: 'operator' }),
      });
      setRefreshing(true); reload();
    } catch (e) { Alert.alert('Error', String(e)); }
  };
  return (
    <ScrollView style={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); reload(); }} />}>
      {loading && <Centered><ActivityIndicator /></Centered>}
      {err && <ErrBox msg={err} />}
      <Section title="PENDING APPROVALS">
        {data && (data.approvals || []).filter(a => a.status === 'pending').map((a, i) => (
          <Card key={i}>
            <Row k="requester" v={a.requester} />
            <Row k="action" v={a.action} />
            <Row k="target" v={a.target || '—'} />
            <Row k="detail" v={a.detail || '—'} />
            <View style={styles.row2}>
              <TouchableOpacity style={[styles.btn, styles.ok]} onPress={() => resolve(a.id, 'approve')}>
                <Text style={styles.btnTx}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.no]} onPress={() => resolve(a.id, 'deny')}>
                <Text style={styles.btnTx}>Deny</Text>
              </TouchableOpacity>
            </View>
          </Card>
        ))}
        {data && (data.approvals || []).filter(a => a.status === 'pending').length === 0 && <Text style={styles.muted}>none pending</Text>}
      </Section>
    </ScrollView>
  );
}

function Logs({ api }) {
  const { data, err, loading, refreshing, reload, setRefreshing } = usePoller(api, '/api/logs/operator');
  return (
    <ScrollView style={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); reload(); }} />}>
      {loading && <Centered><ActivityIndicator /></Centered>}
      {err && <ErrBox msg={err} />}
      <Section title="OPERATOR LOG">
        <Card>
          {(data && data.lines || []).map((l, i) => <Text key={i} style={styles.logline}>{l}</Text>)}
          {(!data || !(data.lines || []).length) && <Text style={styles.muted}>empty</Text>}
        </Card>
      </Section>
    </ScrollView>
  );
}

function Settings({ base, setBase }) {
  const [v, setV] = useState(base);
  return (
    <ScrollView style={styles.scroll}>
      <Section title="MC BASE URL">
        <Card>
          <Text style={styles.label}>Reachable MC endpoint</Text>
          <Input placeholder="http://host:8777" value={v} onChange={setV} />
          <Text style={styles.muted}>Physical phone: forward <lan-host-ip>:8777 → WSL, then use that IP.{'\n'}Emulator: adb reverse tcp:8777 tcp:8777, use http://10.0.2.2:8777</Text>
          <TouchableOpacity style={styles.btn} onPress={() => setBase(v.trim() || DEFAULT_BASE)}>
            <Text style={styles.btnTx}>Save</Text>
          </TouchableOpacity>
        </Card>
      </Section>
    </ScrollView>
  );
}

/* ---------- small UI primitives ---------- */
function Section({ title, children }) {
  return (<View style={styles.section}><Text style={styles.sectionTx}>{title}</Text>{children}</View>);
}
function Card({ children }) {
  return (<View style={styles.card}>{children}</View>);
}
function Row({ k, v }) {
  return (<View style={styles.row}><Text style={styles.rk}>{k}</Text><Text style={styles.rv}>{String(v ?? '')}</Text></View>);
}
function Input({ placeholder, value, onChange, multiline }) {
  return (
    <TextInput style={[styles.input, multiline && styles.inputMl]} placeholder={placeholder}
      placeholderTextColor="#5a6b5a" value={value} onChangeText={onChange}
      multiline={multiline} secureTextEntry={false} autoCapitalize="none" autoCorrect={false} />
  );
}
function Centered({ children }) { return (<View style={styles.centered}>{children}</View>); }
function ErrBox({ msg }) { return (<View style={styles.errBox}><Text style={styles.errTx}>{msg}</Text></View>); }

const C = {
  bg: '#0a0e0a', panel: '#10160f', card: '#15201a', line: '#223022',
  txt: '#cfe8cf', dim: '#7fae7f', acc: '#4caf50', warn: '#e0b341', err: '#e0604f',
};
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 14, paddingBottom: 8, gap: 8 },
  brand: { color: C.acc, fontWeight: '800', letterSpacing: 1, fontSize: 15 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotIdle: { backgroundColor: '#555' }, dotOk: { backgroundColor: C.acc }, dotErr: { backgroundColor: C.err },
  base: { color: C.dim, fontSize: 11, flexShrink: 1 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderColor: C.line },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabOn: { borderBottomWidth: 2, borderColor: C.acc },
  tabTx: { color: C.dim, fontSize: 12, fontWeight: '700' },
  tabTxOn: { color: C.acc },
  body: { flex: 1 },
  scroll: { flex: 1, padding: 12 },
  section: { marginBottom: 14 },
  sectionTx: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
  card: { backgroundColor: C.card, borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: C.line },
  row: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  rk: { color: C.dim, fontSize: 11, width: 80, fontWeight: '700' },
  rv: { color: C.txt, fontSize: 12, flexShrink: 1, flexWrap: 'wrap' },
  wrap: { color: C.txt, fontSize: 12, flexWrap: 'wrap' },
  label: { color: C.txt, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  input: { backgroundColor: '#0c130c', borderWidth: 1, borderColor: C.line, borderRadius: 8, color: C.txt, padding: 10, fontSize: 13, marginBottom: 8 },
  inputMl: { height: 70, textAlignVertical: 'top' },
  btn: { backgroundColor: C.acc, borderRadius: 8, paddingVertical: 11, alignItems: 'center', marginTop: 4 },
  btnTx: { color: '#04140a', fontWeight: '800', fontSize: 13 },
  row2: { flexDirection: 'row', gap: 8, marginTop: 8 },
  ok: { backgroundColor: C.acc, flex: 1 }, no: { backgroundColor: C.err, flex: 1 },
  form: { backgroundColor: C.panel, borderRadius: 10, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: C.line },
  centered: { padding: 30, alignItems: 'center' },
  muted: { color: C.dim, fontSize: 12, fontStyle: 'italic', paddingVertical: 4 },
  warn: { color: C.warn, fontSize: 12, padding: 8 },
  errBox: { backgroundColor: '#2a1410', borderWidth: 1, borderColor: C.err, borderRadius: 8, padding: 10, marginBottom: 8 },
  errTx: { color: C.err, fontSize: 12 },
  logline: { color: C.txt, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', paddingVertical: 1 },
});
