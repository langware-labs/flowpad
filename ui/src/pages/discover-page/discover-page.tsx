import flowpadLogo from '@src/assets/logo.png';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { Button } from '@src/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@src/components/ui/sheet';
import {
  BadgeCheck,
  Boxes,
  Check,
  ChevronRight,
  Copy,
  Diamond,
  Grid2x2,
  Hexagon,
  Network,
  Search,
  ShieldCheck,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

/* ────────────────────────── types & metadata ────────────────────────── */

type HarnessKey = 'claude' | 'codex' | 'copilot';
type AssetKind = 'skill' | 'mcp' | 'agent' | 'plugin';
type TrustKey = 'verified' | 'signed' | 'community';

const HARNESS: Record<HarnessKey, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};
const HARNESS_KEYS = Object.keys(HARNESS) as HarnessKey[];

const TYPE_META: Record<AssetKind, { label: string; Icon: typeof Diamond }> = {
  skill: { label: 'Skill', Icon: Diamond },
  mcp: { label: 'MCP', Icon: Network },
  agent: { label: 'Agent', Icon: Boxes },
  plugin: { label: 'Plugin', Icon: Hexagon },
};
const TYPE_KEYS = Object.keys(TYPE_META) as AssetKind[];

const TRUST: Record<TrustKey, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' },
  signed: { label: 'Signed release', cls: 'text-sky-500 bg-sky-500/10 border-sky-500/20' },
  community: { label: 'Community', cls: 'text-muted-foreground bg-muted border-border' },
};

interface Team {
  name: string;
  handle: string;
  verified: boolean;
}
interface Asset {
  team: Team;
  name: string;
  repo: string;
  description: string;
  stars: number;
  version: string;
  types: AssetKind[];
  harnesses: HarnessKey[];
  trust: TrustKey;
  scopeDefault: 'project' | 'user';
  contents: { kind: AssetKind; name: string }[];
  permissions: ('local-code' | 'network')[];
}

/* ────────────────────────── mock catalogue ────────────────────────── */

// Internal company groups — different teams across the organization that
// publish assets to the shared catalogue. `verified` = officially endorsed
// by the org (vs. an experimental/community-run group).
const TEAMS: Record<string, Team> = {
  platform: { name: 'Platform', handle: 'platform', verified: true },
  dataPlatform: { name: 'Data Platform', handle: 'data-platform', verified: true },
  devex: { name: 'Developer Experience', handle: 'devex', verified: true },
  designSystems: { name: 'Design Systems', handle: 'design-systems', verified: true },
  security: { name: 'Security', handle: 'security', verified: true },
  growth: { name: 'Growth', handle: 'growth', verified: false },
};

const ASSETS: Asset[] = [
  {
    team: TEAMS.dataPlatform, name: 'web-scraper', repo: 'web-scraper',
    description: 'Headless browsing + structured extraction for research agents.',
    stars: 2840, version: '1.4.0', types: ['skill', 'mcp'],
    harnesses: ['claude', 'codex', 'copilot'], trust: 'verified', scopeDefault: 'project',
    contents: [{ kind: 'skill', name: 'scrape-page' }, { kind: 'skill', name: 'extract-table' }, { kind: 'mcp', name: 'browser-server' }],
    permissions: ['network', 'local-code'],
  },
  {
    team: TEAMS.devex, name: 'pr-reviewer', repo: 'pr-reviewer',
    description: 'Opinionated diff review with security + style passes as a native agent.',
    stars: 5120, version: '2.1.3', types: ['agent', 'skill'],
    harnesses: ['claude', 'copilot'], trust: 'signed', scopeDefault: 'project',
    contents: [{ kind: 'agent', name: 'reviewer' }, { kind: 'skill', name: 'diff-summary' }],
    permissions: ['local-code'],
  },
  {
    team: TEAMS.dataPlatform, name: 'postgres-mcp', repo: 'postgres-mcp',
    description: 'Read-only Postgres introspection + safe query tooling over MCP.',
    stars: 1890, version: '0.9.1', types: ['mcp'],
    harnesses: ['claude', 'codex', 'copilot'], trust: 'verified', scopeDefault: 'user',
    contents: [{ kind: 'mcp', name: 'pg-introspect' }, { kind: 'mcp', name: 'pg-query' }],
    permissions: ['network'],
  },
  {
    team: TEAMS.growth, name: 'linkedin-suite', repo: 'linkedin-suite',
    description: 'Profile + outreach skills tuned for social automation workflows.',
    stars: 980, version: '1.0.7', types: ['skill'],
    harnesses: ['claude', 'codex'], trust: 'community', scopeDefault: 'project',
    contents: [{ kind: 'skill', name: 'profile-research' }, { kind: 'skill', name: 'draft-outreach' }],
    permissions: ['network'],
  },
  {
    team: TEAMS.platform, name: 'release-runner', repo: 'release-runner',
    description: 'End-to-end release orchestration as a Claude plugin bundle.',
    stars: 3410, version: '3.0.0', types: ['plugin', 'agent', 'skill'],
    harnesses: ['claude'], trust: 'signed', scopeDefault: 'project',
    contents: [{ kind: 'agent', name: 'release-captain' }, { kind: 'skill', name: 'changelog' }, { kind: 'skill', name: 'tag-and-push' }],
    permissions: ['local-code', 'network'],
  },
  {
    team: TEAMS.designSystems, name: 'figma-bridge', repo: 'figma-bridge',
    description: 'Pull frames and tokens from Figma into your agent context via MCP.',
    stars: 1450, version: '0.6.2', types: ['mcp', 'skill'],
    harnesses: ['claude', 'codex', 'copilot'], trust: 'verified', scopeDefault: 'user',
    contents: [{ kind: 'mcp', name: 'figma-server' }, { kind: 'skill', name: 'tokens-to-css' }],
    permissions: ['network'],
  },
  {
    team: TEAMS.devex, name: 'test-author', repo: 'test-author',
    description: 'Generates and repairs unit tests from a failing run — portable skill.',
    stars: 760, version: '1.2.0', types: ['skill'],
    harnesses: ['claude', 'codex', 'copilot'], trust: 'community', scopeDefault: 'project',
    contents: [{ kind: 'skill', name: 'author-tests' }, { kind: 'skill', name: 'repair-suite' }],
    permissions: ['local-code'],
  },
  {
    team: TEAMS.security, name: 'k8s-copilot', repo: 'k8s-copilot',
    description: 'Cluster inspection + manifest authoring agent with MCP cluster access.',
    stars: 2230, version: '1.8.4', types: ['agent', 'mcp'],
    harnesses: ['codex', 'copilot'], trust: 'signed', scopeDefault: 'user',
    contents: [{ kind: 'agent', name: 'cluster-ops' }, { kind: 'mcp', name: 'kube-server' }],
    permissions: ['network', 'local-code'],
  },
];

const fmtStars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${n}`);
const monogram = (name: string) => {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
};

const SCOPE_LABELS: Record<'project' | 'user', string> = { project: 'Project', user: 'Global' };
const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

// Add/remove a value in a Set immutably and hand the new Set to a setter.
function toggleInSet<T>(set: Set<T>, v: T, setter: (s: Set<T>) => void) {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  setter(next);
}

// Teams that have published at least one asset, with their asset counts.
// Derived once from the static catalogue — never changes at runtime.
const FEATURED_TEAMS = (() => {
  const counts = new Map<string, number>();
  ASSETS.forEach((a) => counts.set(a.team.handle, (counts.get(a.team.handle) ?? 0) + 1));
  return Object.values(TEAMS)
    .map((t) => ({ team: t, count: counts.get(t.handle) ?? 0 }))
    .filter((t) => t.count > 0);
})();

/* ────────────────────────── small building blocks ────────────────────────── */

function TeamAvatar({ team, size = 'md' }: { team: Team; size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'h-11 w-11 text-sm' : size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs';
  return (
    <div className={`relative shrink-0 ${dim} grid place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 font-semibold text-primary-foreground`}>
      {monogram(team.name)}
      {team.verified && (
        <span className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-background">
          <BadgeCheck className="h-3.5 w-3.5 text-sky-500" />
        </span>
      )}
    </div>
  );
}

function TypeBadge({ kind }: { kind: AssetKind }) {
  const { label, Icon } = TYPE_META[kind];
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

function TrustBadge({ trust, className }: { trust: TrustKey; className?: string }) {
  const t = TRUST[trust];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.cls} ${className ?? ''}`}>{t.label}</span>
  );
}

function CompatChip({ harness, on }: { harness: HarnessKey; on: boolean }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        on
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground line-through opacity-50'
      }`}
    >
      {HARNESS[harness]}
    </span>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
    [text],
  );
  return (
    <button
      onClick={onCopy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        copied ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-muted hover:border-primary'
      }`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/* ────────────────────────── filter chip ────────────────────────── */

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/* ────────────────────────── asset card ────────────────────────── */

function AssetCard({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
  return (
    <article
      onClick={onOpen}
      className="group flex cursor-pointer flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5"
    >
      {/* team-led header */}
      <div className="flex items-center gap-2.5">
        <TeamAvatar team={asset.team} />
        <div className="min-w-0">
          <p className="flex items-center gap-1 truncate text-xs font-medium">
            {asset.team.name}
            {asset.team.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-sky-500" />}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{asset.team.handle}/{asset.repo}</p>
        </div>
      </div>

      <h3 className="mt-3 truncate font-semibold tracking-tight">{asset.name}</h3>
      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{asset.description}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {asset.types.map((t) => <TypeBadge key={t} kind={t} />)}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {HARNESS_KEYS.map((h) => <CompatChip key={h} harness={h} on={asset.harnesses.includes(h)} />)}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t pt-4">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5" /> {fmtStars(asset.stars)}
        </span>
        <TrustBadge trust={asset.trust} />
        <Button size="sm" className="ml-auto h-7 gap-1 px-3 text-xs">
          Install <ChevronRight className="h-3 w-3" />
        </Button>
      </div>
    </article>
  );
}

/* ────────────────────────── detail slide-over ────────────────────────── */

function DetailPanel({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [harness, setHarness] = useState<HarnessKey>(asset.harnesses.includes('claude') ? 'claude' : asset.harnesses[0]);
  const [scope, setScope] = useState<'project' | 'user'>(asset.scopeDefault);
  const supported = asset.harnesses.includes(harness);
  const cmd = `npx flowpad add ${asset.team.handle}/${asset.repo} --target ${harness} --scope ${scope}`;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full max-w-2xl flex-col gap-0 bg-card p-0 sm:max-w-2xl">
        {/* header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card/85 px-6 py-4 pr-12 backdrop-blur-xl">
          <TeamAvatar team={asset.team} size="lg" />
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-lg font-semibold leading-tight tracking-tight">
              {asset.name}
              <span className="font-mono text-sm font-normal text-muted-foreground">@{asset.version}</span>
            </SheetTitle>
            <SheetDescription className="flex items-center gap-1 truncate font-mono text-xs text-primary">
              by {asset.team.name}
              {asset.team.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-sky-500" />}
              <span className="text-muted-foreground"> · {asset.team.handle}/{asset.repo} ↗</span>
            </SheetDescription>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            {asset.types.map((t) => <TypeBadge key={t} kind={t} />)}
            <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Star className="h-3.5 w-3.5" /> {fmtStars(asset.stars)}
            </span>
            <TrustBadge trust={asset.trust} className="ml-1" />
          </div>

          <p className="text-sm leading-relaxed text-muted-foreground">{asset.description}</p>

          {/* INSTALL */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className={SECTION_TITLE}>Install</h3>
              <div className="flex items-center gap-0.5 rounded-lg border bg-muted p-0.5">
                {(['project', 'user'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      scope === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {SCOPE_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="flex border-b">
                {HARNESS_KEYS.map((h) => {
                  const avail = asset.harnesses.includes(h);
                  return (
                    <button
                      key={h}
                      onClick={() => setHarness(h)}
                      className={`border-b-2 px-3.5 py-2 text-sm font-medium transition-colors ${
                        harness === h ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                      } ${avail ? '' : 'opacity-50'}`}
                    >
                      {HARNESS[h]}
                    </button>
                  );
                })}
              </div>
              {supported ? (
                <div className="flex items-center gap-3 px-4 py-4">
                  <span className="select-none font-mono text-primary">$</span>
                  <code className="flex-1 break-all font-mono text-[13px]">{cmd}</code>
                  <CopyButton text={cmd} />
                </div>
              ) : (
                <div className="flex items-start gap-2.5 px-4 py-5 text-sm text-muted-foreground">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>
                    Not available for {HARNESS[harness]} — this repo ships only the portable core. Native{' '}
                    {HARNESS[harness]} adapters haven&apos;t been published.
                  </span>
                </div>
              )}
            </div>
            {supported && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                Writes {scope === 'project' ? 'repo-local' : '~/-global'} paths for {HARNESS[harness]} (symlink mode).
              </p>
            )}
          </section>

          {/* CONTENTS */}
          <section>
            <h3 className={`mb-2 ${SECTION_TITLE}`}>Contents</h3>
            <div className="overflow-hidden rounded-xl border bg-card">
              {asset.contents.map((c, i) => {
                const { Icon, label } = TYPE_META[c.kind];
                return (
                  <div key={i} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0">
                    <Icon className="h-4 w-4 text-primary" />
                    <span className="font-mono text-sm">{c.name}</span>
                    <span className="ml-auto text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* TRUST */}
          <section>
            <h3 className={`mb-2 ${SECTION_TITLE}`}>Trust &amp; provenance</h3>
            <div className="space-y-2.5 rounded-xl border bg-card p-4 text-sm">
              <div className="flex items-center gap-2">
                <ShieldCheck className={`h-4 w-4 ${asset.trust !== 'community' ? 'text-emerald-500' : 'text-muted-foreground'}`} />
                <span>
                  {asset.trust === 'verified'
                    ? 'Verified publisher, signed release'
                    : asset.trust === 'signed'
                      ? 'Signed release'
                      : 'Community-published — unsigned'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-500" />
                <span>Pinned to <span className="font-mono">@{asset.version}</span> · immutable release</span>
              </div>
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span className="flex flex-wrap items-center gap-1.5">
                  Permissions:
                  {asset.permissions.map((p) => (
                    <span key={p} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {p === 'local-code' ? 'runs local code' : 'network access'}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </section>

          {/* README */}
          <section>
            <h3 className={`mb-2 ${SECTION_TITLE}`}>Readme</h3>
            <div className="space-y-2 rounded-xl border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">## {asset.name}</p>
              <p>
                {asset.description} Authored as an open-core asset: a <span className="font-mono">SKILL.md</span> +{' '}
                <span className="font-mono">AGENTS.md</span> source of truth, materialized into each harness&apos;s native
                paths at install.
              </p>
              <p className="opacity-60">### Usage · ### Configuration · ### License — MIT</p>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function DiscoverPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<Set<AssetKind>>(new Set());
  const [harnesses, setHarnesses] = useState<Set<HarnessKey>>(new Set());
  const [team, setTeam] = useState<string | null>(null);
  const [sort, setSort] = useState<'trending' | 'recent' | 'stars'>('trending');
  const [openAsset, setOpenAsset] = useState<Asset | null>(null);

  const list = useMemo(() => {
    const q = query.toLowerCase();
    let r = ASSETS.filter(
      (a) =>
        (!q || a.name.includes(q) || a.description.toLowerCase().includes(q) || a.repo.includes(q) || a.team.name.toLowerCase().includes(q)) &&
        (types.size === 0 || a.types.some((t) => types.has(t))) &&
        (harnesses.size === 0 || a.harnesses.some((h) => harnesses.has(h))) &&
        (!team || a.team.handle === team),
    );
    if (sort === 'stars' || sort === 'trending') r = [...r].sort((x, y) => y.stars - x.stars);
    return r;
  }, [query, types, harnesses, team, sort]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* ── app chrome header ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 px-4 py-2 backdrop-blur-xl">
        <button onClick={() => void navigate('/')} aria-label="Back to home" className="flex items-center">
          <img src={flowpadLogo} alt="Flowpad" className="max-h-7 object-contain dark:brightness-0 dark:invert" />
        </button>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <UserDropdown />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-5">
          {/* ── hero ── */}
          <section className="relative overflow-hidden pb-8 pt-12">
            <div
              className="pointer-events-none absolute inset-0 opacity-60"
              style={{ background: 'radial-gradient(600px 280px at 30% -20%, hsl(var(--primary) / 0.12), transparent 70%)' }}
            />
            <div className="relative">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                Portable core · Claude Code · Codex · Copilot
              </div>
              <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
                Discover agentic assets.
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
                Skills, MCP servers, and agents — published by teams across your organization. Install into Claude Code, Codex, or Copilot{' '}
                <span className="font-medium text-foreground">in one line.</span>
              </p>

              <div className="mt-7 max-w-2xl overflow-hidden rounded-xl border bg-card shadow-lg shadow-primary/5">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                  <span className="ml-2 font-mono text-xs text-muted-foreground">install any asset</span>
                </div>
                <div className="flex items-center gap-3 px-4 py-4">
                  <span className="select-none font-mono text-primary">$</span>
                  <code className="flex-1 truncate font-mono text-sm">
                    npx flowpad add <span className="text-primary">team/repo</span> --target <span className="text-primary">auto</span>
                  </code>
                  <CopyButton text="npx flowpad add team/repo --target auto" />
                </div>
              </div>
            </div>
          </section>

          {/* ── featured teams ── */}
          <section className="pb-6">
            <div className="mb-3 flex items-center gap-2">
              <h2 className={SECTION_TITLE}>Teams across the org</h2>
              {team && (
                <button onClick={() => setTeam(null)} className="text-[11px] font-medium text-primary hover:underline">
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {FEATURED_TEAMS.map(({ team: t, count }) => {
                const active = team === t.handle;
                return (
                  <button
                    key={t.handle}
                    onClick={() => setTeam(active ? null : t.handle)}
                    className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'bg-card hover:border-primary/50'
                    }`}
                  >
                    <TeamAvatar team={t} size="sm" />
                    <div className="text-left">
                      <p className="flex items-center gap-1 text-xs font-medium leading-tight">
                        {t.name}
                        {t.verified && <BadgeCheck className="h-3 w-3 text-sky-500" />}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{count} asset{count !== 1 ? 's' : ''}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── filter bar ── */}
          <section className="sticky top-[57px] z-20 -mx-1 mb-6 rounded-xl border bg-card/95 px-3.5 py-3 backdrop-blur">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="relative min-w-[180px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search assets, teams…"
                  className="w-full rounded-lg border bg-background py-1.5 pl-8 pr-3 text-sm outline-none focus:border-primary"
                />
              </div>
              <div className="flex items-center gap-1.5">
                {TYPE_KEYS.map((t) => {
                  const { label, Icon } = TYPE_META[t];
                  return (
                    <FilterChip key={t} active={types.has(t)} onClick={() => toggleInSet(types, t, setTypes)}>
                      <Icon className="h-3 w-3" /> {label}
                    </FilterChip>
                  );
                })}
              </div>
              <div className="hidden h-5 border-l md:block" />
              <div className="flex items-center gap-1.5">
                {HARNESS_KEYS.map((h) => (
                  <FilterChip key={h} active={harnesses.has(h)} onClick={() => toggleInSet(harnesses, h, setHarnesses)}>
                    {HARNESS[h]}
                  </FilterChip>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{list.length} asset{list.length !== 1 ? 's' : ''}</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                  className="rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                >
                  <option value="trending">Trending</option>
                  <option value="recent">Recent</option>
                  <option value="stars">Most stars</option>
                </select>
              </div>
            </div>
          </section>

          {/* ── grid ── */}
          <section className="pb-12">
            {list.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {list.map((a) => (
                  <AssetCard key={`${a.team.handle}/${a.repo}`} asset={a} onOpen={() => setOpenAsset(a)} />
                ))}
              </div>
            ) : (
              <div className="py-20 text-center text-muted-foreground">
                <Grid2x2 className="mx-auto mb-3 h-8 w-8 opacity-50" />
                <p className="text-sm">No assets match those filters.</p>
              </div>
            )}
          </section>

          {/* ── footer note ── */}
          <footer className="flex flex-col items-center justify-between gap-3 border-t py-8 text-xs text-muted-foreground sm:flex-row">
            <span>Skills + AGENTS.md + MCP are the portable core; plugins &amp; native agents are per-harness adapters.</span>
            <span className="font-mono">discover · concept</span>
          </footer>
        </div>
      </main>

      {openAsset && <DetailPanel asset={openAsset} onClose={() => setOpenAsset(null)} />}
    </div>
  );
}
