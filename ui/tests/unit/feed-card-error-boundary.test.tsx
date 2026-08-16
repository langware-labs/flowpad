/**
 * Behavioural lock for the Home-Feed per-card `<ErrorBoundary>` (FLOWPAD-1974).
 *
 * Regression: a `flow diagnose` agent fabricated a diagnosis id
 * (`flowpad_diagnostic_20260810_201342`) instead of running `report.py`; the CLI
 * runner scraped it out of the transcript and stamped it onto a Home-Feed
 * `message_suggest` row. Rendering that card runs
 * `new TypeId(FlowpadDiagnosis.type, diagnosisId)` inside a `useMemo`
 * (`diagnosis-report-modal.tsx`), the slug fails `isValidIdentifier`, and the
 * constructor THROWS DURING RENDER.
 *
 * Nothing local caught it. The nearest boundary was react-router's root
 * `errorElement` (`router.tsx`), which works at route granularity — so one bad
 * feed row replaced the ENTIRE app with `<ErrorScreen>`.
 *
 * This drives the REAL `HomeFeedColumn` over two REAL `FeedEntry` rows — one
 * healthy `UserNote`, one `MessageSuggest` carrying the exact poisoned id from
 * the incident. The throw is real (real `TypeId`, real `DiagnosisReportModal`);
 * only the boundary hooks are stood in: entity resolution, feed mutations and
 * dock navigation.
 *
 * The assertion that matters is #1: the SIBLING card survives. Without the
 * boundary the whole tree unmounts and nothing renders at all.
 *
 * Lives in the `unit` tier, not `react`: every hook it touches is stood in, so it
 * needs jsdom but no live launcher-owned backend (which the react tier demands).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { FeedEntry, MessageSuggest, UserNote } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';

const { POISONED_ID, SUGGEST_ID, NOTE_ID, SUGGEST_ENTRY_ID, NOTE_ENTRY_ID } = vi.hoisted(() => ({
  // The literal the agent invented — not a UUID, so `isValidIdentifier` rejects it.
  POISONED_ID: 'flowpad_diagnostic_20260810_201342',
  SUGGEST_ID: '7ac53638-ccf1-44e9-847b-0c6904a82149',
  NOTE_ID: 'b1111111-1111-4111-8111-111111111111',
  SUGGEST_ENTRY_ID: '37c7ae46-89c4-49ab-ad8f-c9b6ff55ecd7',
  NOTE_ENTRY_ID: 'c2222222-2222-4222-8222-222222222222',
}));

const dismissSpy = vi.fn();

vi.mock('@src/hooks/use-feed-mutations', () => ({
  useFeedMutations: () => ({ dismiss: dismissSpy, dismissAll: vi.fn() }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

// Entity resolution seam. `useEntitiesQuery` feeds the column its FeedEntry rows;
// `useEntity` resolves each entry's target (`data.type_id`) to its content entity.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: buildEntries(), refetch: vi.fn().mockResolvedValue(undefined) }),
  useEntity: (typeId: { type: string; id: string } | null) => {
    if (typeId?.id === SUGGEST_ID) return { data: buildSuggest(), isLoading: false };
    if (typeId?.id === NOTE_ID) return { data: buildNote(), isLoading: false };
    return { data: null, isLoading: false };
  },
  useWatch: () => undefined,
}));

// The diagnosis lookup inside DiagnosisReportModal — never reached, because the
// TypeId constructor throws first. Stubbed so the module resolves.
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: null }),
  useAuth: () => ({ cloudUser: null, currentUser: null }),
  useCloudStatus: () => ({ isLoggedIn: false }),
}));

function buildSuggest(): MessageSuggest {
  const suggest = new MessageSuggest({
    id: SUGGEST_ID,
    text: "Flowpad diagnostic finished — here's what we found:",
    message_text: '',
    // The poison: a non-UUID id in a field typed as a bare optional string.
    diagnosis_id: POISONED_ID,
    conversation_id: null,
    flow_message_id: null,
  });
  return suggest;
}

function buildNote(): UserNote {
  return new UserNote({ id: NOTE_ID, content: 'a healthy neighbour card' });
}

function buildEntries(): FeedEntry[] {
  return [
    new FeedEntry({
      id: SUGGEST_ENTRY_ID,
      feed_status: 'new',
      created_date: '2026-08-10T17:16:50.981Z',
      data: { type_id: `${MessageSuggest.type}-${SUGGEST_ID}` },
    }),
    new FeedEntry({
      id: NOTE_ENTRY_ID,
      feed_status: 'new',
      created_date: '2026-08-10T17:00:00.000Z',
      data: { type_id: `${UserNote.type}-${NOTE_ID}` },
    }),
  ];
}

describe('Home feed per-card error boundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error itself; the boundary logs it again on purpose.
    // Silence both so a PASSING run is not full of red noise.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // The unit tier's setup does NOT install RTL's afterEach(cleanup) — only the
    // react tier does. Without this, renders pile up in document.body and
    // `screen` queries match cards left over from the previous test.
    cleanup();
    consoleError.mockRestore();
    vi.clearAllMocks();
  });

  async function renderFeed() {
    const { HomeFeedColumn } = await import('@src/pages/home-landing/feed/HomeFeedColumn');
    return render(
      <TooltipProvider>
        <HomeFeedColumn />
      </TooltipProvider>,
    );
  }

  it('keeps sibling cards alive when one card throws during render', async () => {
    await renderFeed();

    // THE regression: before the boundary, the throw unmounted the whole tree and
    // this neighbour disappeared along with the rest of the app.
    expect(screen.getByText('a healthy neighbour card')).toBeInTheDocument();
  });

  it('renders the crashed card as <InvalidFeedItem>', async () => {
    await renderFeed();

    expect(screen.getByText('Error while displaying the suggestion, contact support')).toBeInTheDocument();
  });

  it('lets the user dismiss a permanently broken card', async () => {
    await renderFeed();

    // Two cards render, but only the crashed one is <InvalidFeedItem> — scope the
    // query to it so this can't accidentally assert on the healthy card's button.
    const broken = screen.getByText('Error while displaying the suggestion, contact support').closest('div')!;
    fireEvent.click(within(broken).getByRole('button', { name: /hide feed entry/i }));

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect(dismissSpy.mock.calls[0][0]).toMatchObject({ id: SUGGEST_ENTRY_ID });
  });

  it('logs the failure so a crashed card is not silent', async () => {
    await renderFeed();

    const logs = consoleError.mock.calls.flat();
    const loggedBy = (needle: string) => logs.some((a) => typeof a === 'string' && a.includes(needle));

    // The boundary carries the error + which entry; the fallback states the
    // user-facing symptom. Both, so neither the cause nor the card is silent.
    expect(loggedBy(`[ErrorBoundary: feed-card:${SUGGEST_ENTRY_ID}]`)).toBe(true);
    expect(loggedBy('[feed] error while displaying the suggestion')).toBe(true);
  });
});
