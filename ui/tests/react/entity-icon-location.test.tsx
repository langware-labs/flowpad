import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgenticProcess } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import {
  EntityIcon,
  EntityIconWithSub,
} from '@src/components/graph-view/ui/EntityIcon';

function renderWithTooltips(node: React.ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>);
}

describe('EntityIcon location treatment', () => {
  it('orders known location before the type glyph and preserves unknown plainness', () => {
    const { container, rerender } = renderWithTooltips(
      <EntityIcon type="skill" remote aria-label="Skill" />,
    );

    const composite = container.querySelector('[data-entity-location="cloud"]')!;
    expect(composite.children[0]).toHaveAttribute('data-location-glyph', 'cloud');
    expect(composite.children[1]).toHaveAttribute('data-entity-type-icon');
    expect(composite).toHaveAccessibleName('Skill, Available on cloud');
    expect(composite.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote={false} aria-label="Skill" />
      </TooltipProvider>,
    );
    const local = container.querySelector('[data-entity-location="local"]')!;
    expect(local.children[0]).toHaveAttribute('data-location-glyph', 'local');
    expect(local).toHaveAccessibleName('Skill, Local only');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" aria-label="Skill" />
      </TooltipProvider>,
    );
    const unknown = container.querySelector('[data-entity-location="unknown"]')!;
    expect(unknown).not.toHaveClass('gap-0');
    expect(unknown.querySelector('[data-location-glyph]')).toBeNull();
    expect(unknown.querySelector('[data-entity-type-icon]')).toBe(unknown.firstElementChild);
    expect(unknown).toHaveAccessibleName('Skill');
  });

  it('gives remote blue final precedence while preserving local caller color', () => {
    const { container, rerender } = renderWithTooltips(
      <EntityIcon
        type="skill"
        remote
        color="red"
        className="h-5 w-5 text-muted-foreground"
      />,
    );
    let typeIcon = container.querySelector('[data-entity-type-icon]')!;
    expect(typeIcon).toHaveClass('text-cloud');
    expect(typeIcon).not.toHaveClass('text-muted-foreground');
    expect(typeIcon).toHaveAttribute('stroke', 'currentColor');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon
          type="skill"
          remote={false}
          color="red"
          className="h-5 w-5 text-amber-500"
        />
      </TooltipProvider>,
    );
    typeIcon = container.querySelector('[data-entity-type-icon]')!;
    expect(typeIcon).toHaveClass('text-amber-500');
    expect(typeIcon).not.toHaveClass('text-cloud');
    expect(typeIcon).toHaveAttribute('stroke', 'red');
  });

  it('preserves explicit type size and stroke while isolating location geometry', () => {
    const { container, rerender } = renderWithTooltips(
      <EntityIcon type="skill" remote size={12} strokeWidth={5} />,
    );
    let typeIcon = container.querySelector('[data-entity-type-icon]')!;
    let locationIcon = container.querySelector('[data-location-glyph]')!;
    expect(typeIcon).toHaveAttribute('width', '12');
    expect(typeIcon).toHaveAttribute('height', '12');
    expect(typeIcon).toHaveAttribute('stroke-width', '5');
    expect(locationIcon).toHaveAttribute('width', '8');
    expect(locationIcon).toHaveAttribute('height', '8');
    expect(locationIcon).toHaveAttribute('stroke-width', '2');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote={false} size={20} strokeWidth={4} />
      </TooltipProvider>,
    );
    typeIcon = container.querySelector('[data-entity-type-icon]')!;
    locationIcon = container.querySelector('[data-location-glyph]')!;
    expect(typeIcon).toHaveAttribute('width', '20');
    expect(typeIcon).toHaveAttribute('height', '20');
    expect(locationIcon).toHaveAttribute('width', '16');
    expect(locationIcon).toHaveAttribute('height', '16');
    expect(locationIcon).toHaveAttribute('stroke-width', '2');
  });

  it('uses density for default size and gap only', () => {
    const { container, rerender } = renderWithTooltips(
      <EntityIcon type="skill" remote />,
    );
    let composite = container.querySelector('[data-entity-location]')!;
    expect(composite).toHaveClass('gap-1');
    expect(composite.querySelector('[data-entity-type-icon]')).toHaveAttribute('width', '16');
    expect(composite.querySelector('[data-location-glyph]')).toHaveAttribute('width', '12');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote density="compact" />
      </TooltipProvider>,
    );
    composite = container.querySelector('[data-entity-location]')!;
    expect(composite).toHaveClass('gap-0.5');
    expect(composite.querySelector('[data-entity-type-icon]')).toHaveAttribute('width', '14');
    expect(composite.querySelector('[data-location-glyph]')).toHaveAttribute('width', '10');
  });

  it('shows exact portalled tooltips only when the primitive owns them', async () => {
    const user = userEvent.setup();
    const { container, rerender } = renderWithTooltips(
      <EntityIcon type="skill" remote />,
    );

    await user.hover(container.querySelector('[data-location-glyph="cloud"]')!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Available on cloud');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote={false} />
      </TooltipProvider>,
    );
    await user.hover(container.querySelector('[data-location-glyph="local"]')!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Local only');

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote showLocationTooltip={false} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('[data-location-glyph="cloud"]')).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-location-glyph]')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps composite accessibility when tooltip is host-owned and suppresses it when hidden', () => {
    const { container, rerender } = renderWithTooltips(
      <EntityIcon
        type="skill"
        remote
        aria-label="Open Skill"
        showLocationTooltip={false}
      />,
    );
    expect(screen.getByRole('img', { name: 'Open Skill, Available on cloud' })).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <EntityIcon type="skill" remote={false} aria-label="Skill" aria-hidden="true" />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-entity-location="local"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('attaches the vendor badge only to the type stack and isolates remote blue', () => {
    const process = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      worker_type: 'claude',
      remote: true,
    });
    const { container } = renderWithTooltips(
      <EntityIconWithSub
        entity={process}
        typeStackClassName="text-amber-500"
        aria-label="Agentic process"
      />,
    );

    const composite = container.querySelector('[data-entity-location="cloud"]')!;
    expect(composite.children[0]).toHaveAttribute('data-location-glyph', 'cloud');
    const typeStack = composite.querySelector('[data-entity-type-icon]')!;
    const svgs = typeStack.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0]).toHaveClass('text-cloud');
    expect(svgs[1]).not.toHaveClass('text-cloud');
    expect(typeStack.firstElementChild).toHaveClass('text-amber-500');
    expect(composite).toHaveAccessibleName('Agentic process, Available on cloud');
  });
});
