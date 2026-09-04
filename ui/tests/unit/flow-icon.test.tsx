/**
 * `FlowIcon` — the component the app can actually adopt.
 *
 * The claim these tests exist to hold: `flowIconComponent(tag)` has the same
 * signature and return type as `lucideByName(name)`, and a rendered icon accepts
 * everything the app already passes. If both hold, migrating is rewiring one
 * function rather than editing 81 files. If either quietly stops holding, the
 * migration breaks at ~1,600 call sites instead of here.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowIcon, FLOW_ICON_SIZES, flowIconComponent } from '@sdk/react/FlowIcon';
import { loadIconPacks, registerBundleRenderer, setIconFallback, type IconPackSpec } from '@sdk/icons';
import { lucideByName } from '@src/lib/lucide-by-name';

const PACKS: IconPackSpec[] = [
  {
    kind: 'brands',
    base: 'icons/brands/assets',
    icons: [
      { kind: 'slack', asset: 'slack.svg', tintable: false, aliases: ['Slack'] },
      { kind: 'gitlab', asset: 'gitlab.svg', color: '#FC6D26' },
      { kind: 'claude', asset: 'claude.svg', sub: { restore: 'lucide.history' } },
    ],
  },
  { kind: 'flowpad', base: 'icons/flowpad/assets', icons: [{ kind: 'wiki', asset: 'wiki.svg' }] },
  { kind: 'lucide', base: 'icons/lucide/assets', icons: [], served: ['rss', 'history', 'file-text'] },
];

loadIconPacks(PACKS);
afterEach(() => registerBundleRenderer(null));

const glyph = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe('flowIconComponent — the lucideByName drop-in', () => {
  it('accepts the same inputs as lucideByName and renders for every one', () => {
    // Both take `string | null | undefined`. Note lucide's own components are
    // forwardRef OBJECTS, not functions, so the test is "React can render it",
    // not "it is a function".
    for (const input of ['brands.slack', '', null, undefined]) {
      const Mine = flowIconComponent(input);
      const Theirs = lucideByName(input);
      expect(render(<Mine />).container.firstElementChild).not.toBeNull();
      expect(render(<Theirs />).container.firstElementChild).not.toBeNull();
    }
  });

  it('falls back to the generic glyph rather than rendering nothing', () => {
    // `lucideByName` lands a null name, a typo and a missing file all on
    // FileText. A drop-in that rendered null instead would make missing icons
    // vanish — which reads as a layout bug and loses the column that said what
    // a row was.
    const { container } = render(<FlowIcon icon="Nonexsitent" />);
    expect(container.firstElementChild).not.toBeNull();
    expect(glyph(container).getAttribute('style')).toContain('file-text.svg');
  });

  it('can be told to render nothing instead', () => {
    setIconFallback(null);
    try {
      expect(render(<FlowIcon icon="Nonexsitent" />).container.firstElementChild).toBeNull();
    } finally {
      setIconFallback('lucide.file-text');
    }
  });

  it('returns a stable component per tag', () => {
    // A table rebuilt on every render must not mint a new component type each
    // time — React would unmount and remount the whole subtree.
    expect(flowIconComponent('brands.slack')).toBe(flowIconComponent('brands.slack'));
    expect(flowIconComponent('brands.slack')).not.toBe(flowIconComponent('flowpad.wiki'));
  });

  it('can be stored in a table and rendered later, like the rail does', () => {
    const table = [{ id: 'tasks', icon: flowIconComponent('flowpad.wiki') }];
    const Icon = table[0].icon;
    const { container } = render(<Icon className="h-4 w-4" />);
    expect(glyph(container).className).toContain('h-4 w-4');
  });
});

describe('FlowIcon props', () => {
  it('passes className straight through — the app sizes with it', () => {
    const { container } = render(<FlowIcon icon="brands.slack" className="h-3.5 w-3.5 text-muted-foreground" />);
    expect(glyph(container).className).toContain('h-3.5 w-3.5');
    expect(glyph(container).className).toContain('text-muted-foreground');
  });

  it('maps the named size scale to the classes the app actually uses', () => {
    for (const [size, cls] of Object.entries(FLOW_ICON_SIZES)) {
      const { container } = render(<FlowIcon icon="brands.slack" size={size as keyof typeof FLOW_ICON_SIZES} />);
      expect(glyph(container).className).toContain(cls);
    }
  });

  it('accepts a pixel size, which is a live pattern not a convenience', () => {
    // 35 call sites pass `size={14}`, and EntityIcon computes one from its
    // density (`size ?? (compact ? 14 : 16)`). A names-only prop rejects those.
    const { container } = render(<FlowIcon icon="flowpad.wiki" size={14} />);
    expect(glyph(container).style.width).toBe('14px');
    expect(glyph(container).style.height).toBe('14px');
  });

  it('hands a pixel size to the bundle renderer as its own size prop', () => {
    const seen: Record<string, unknown>[] = [];
    const Bundled = (props: Record<string, unknown>) => {
      seen.push(props);
      return <svg />;
    };
    registerBundleRenderer(() => Bundled);
    render(<FlowIcon icon="lucide.rss" size={22} />);
    expect(seen[0]?.size).toBe(22);
  });

  it('addresses the base and the badge separately', () => {
    // `IconWithBadge` — the composer this replaces — has baseClassName and
    // badgeClassName because call sites tint the badge alone, and RagFolderIcon
    // replaces the corner geometry outright. One shared className cannot do it.
    const { container } = render(
      <FlowIcon icon="brands.claude" role="restore" baseClassName="base-x" badgeClassName="badge-y" />,
    );
    const stack = glyph(container);
    expect(stack.querySelector('.fp-icon-base')?.className).toContain('base-x');
    expect(stack.querySelector('.fp-icon-sub')?.className).toContain('badge-y');
  });

  it('lets className win over the size prop', () => {
    const { container } = render(<FlowIcon icon="brands.slack" size="xs" className="h-8 w-8" />);
    expect(glyph(container).className).toContain('h-8 w-8');
  });

  it('is decorative by default and an image when named', () => {
    const { container } = render(<FlowIcon icon="brands.slack" />);
    expect(glyph(container).getAttribute('aria-hidden')).toBe('true');

    render(<FlowIcon icon="brands.slack" title="Slack" />);
    expect(screen.getByRole('img', { name: 'Slack' })).toBeTruthy();
  });

  it('applies the spec colour, and lets the color prop override it', () => {
    const { container: declared } = render(<FlowIcon icon="brands.gitlab" />);
    expect(glyph(declared).style.backgroundColor).toBeTruthy();

    const { container: overridden } = render(<FlowIcon icon="brands.gitlab" color="rgb(1, 2, 3)" />);
    expect(glyph(overridden).style.backgroundColor).toBe('rgb(1, 2, 3)');
  });

  it('spreads the rest onto the element, so onClick and data-* land', () => {
    const onClick = vi.fn();
    const { container } = render(<FlowIcon icon="brands.slack" onClick={onClick} data-testid="x" />);
    const el = glyph(container);
    expect(el.getAttribute('data-testid')).toBe('x');
    (el as HTMLElement).click();
    expect(onClick).toHaveBeenCalled();
  });

  it('composes a sub-icon when the role declares one', () => {
    const { container } = render(<FlowIcon icon="brands.claude" role="restore" />);
    expect(glyph(container).classList.contains('fp-icon-stack')).toBe(true);
    expect(glyph(container).querySelector('.fp-icon-sub')).not.toBeNull();
  });

});

describe('the bundle seam', () => {
  it('draws from the registered renderer instead of fetching a file', () => {
    // Without this, migrating a lucide name turns tree-shaken inline SVG into
    // one HTTP request per glyph.
    const Bundled = ({ className }: { className?: string }) => <svg data-bundled="yes" className={className} />;
    registerBundleRenderer(() => Bundled);

    const { container } = render(<FlowIcon icon="lucide.rss" className="h-4 w-4" />);
    const el = glyph(container);
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.getAttribute('data-bundled')).toBe('yes');
    expect(el.getAttribute('class')).toContain('h-4 w-4');
  });

  it('receives the leaf name, so the app converts to its own convention', () => {
    const seen: string[] = [];
    registerBundleRenderer((name) => {
      seen.push(name);
      return undefined;
    });
    render(<FlowIcon icon="lucide.rss" />);
    expect(seen).toContain('rss');
  });

  it('falls back to the served file when no renderer is installed', () => {
    const { container } = render(<FlowIcon icon="lucide.rss" />);
    expect(glyph(container).getAttribute('style')).toContain('rss.svg');
  });
});
