/**
 * Model sizes (sm/md/lg) on an endpoint: the editor shows what "Inherit" resolves to, a choice
 * changes only its own size, the save payload carries the sizes (and a root's catalog), and the
 * LLM preferences are surfaced in their own category.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_LLM_TIERS, getSurfacedPrefInfos, LLMEndpoint, PREF_CATEGORIES, PrefKey } from '@sdk';

import { TiersEditor } from '@src/components/llm-endpoints/TiersEditor';
import {
  buildEntityJson,
  catalogFromText,
  draftFrom,
  emptyDraft,
} from '@src/components/llm-endpoints/endpoint-catalog';

const FLASH = 'google/gemini-3.1-flash-lite';
const PRO = 'google/gemini-3.1-pro-preview';

afterEach(() => cleanup());

describe('TiersEditor', () => {
  it('an unset size says which model it inherits, or why there is none', () => {
    render(
      <TiersEditor
        value={{ ...EMPTY_LLM_TIERS }}
        onChange={() => {}}
        models={[FLASH, PRO]}
        effective={{
          sm: { model: FLASH, set_by: 'llm_endpoint-org', reason: '' },
          md: { model: PRO, set_by: 'inherited', reason: '' },
          lg: { model: null, set_by: null, reason: "no endpoint on the chain declares a 'lg' model" },
        }}
      />,
    );
    expect(screen.getByTestId('tier-sm-inherited').textContent).toBe(`Inherits ${FLASH}`);
    expect(screen.getByTestId('tier-lg-inherited').textContent).toContain("declares a 'lg' model");
    expect(screen.getByTestId<HTMLSelectElement>('tier-sm').value).toBe('');
  });

  it('choosing a model changes that size only; Inherit clears it', async () => {
    const onChange = vi.fn();
    render(<TiersEditor value={{ sm: null, md: PRO, lg: PRO }} onChange={onChange} models={[FLASH, PRO]} />);
    await userEvent.selectOptions(screen.getByTestId('tier-sm'), FLASH);
    expect(onChange).toHaveBeenLastCalledWith({ sm: FLASH, md: PRO, lg: PRO });
    await userEvent.selectOptions(screen.getByTestId('tier-md'), '');
    expect(onChange).toHaveBeenLastCalledWith({ sm: null, md: null, lg: PRO });
  });

  it('a saved model the catalog no longer lists stays selected', () => {
    render(<TiersEditor value={{ sm: 'gone/model', md: null, lg: null }} onChange={() => {}} models={[FLASH]} />);
    expect(screen.getByTestId<HTMLSelectElement>('tier-sm').value).toBe('gone/model');
  });
});

describe('endpoint payload', () => {
  it('a root sends its sizes and its catalog; a chain sends sizes only', () => {
    const root = {
      ...emptyDraft('root'),
      name: 'org',
      models: `${FLASH}\n${PRO}\n${FLASH}\n`,
      tiers: { sm: FLASH, md: PRO, lg: null },
    };
    expect(buildEntityJson(root, true)).toMatchObject({
      tiers: { sm: FLASH, md: PRO, lg: null },
      models: [FLASH, PRO],
    });
    const chain = { ...emptyDraft('chain'), name: 'team', tiers: { sm: null, md: FLASH, lg: null } };
    const json = buildEntityJson(chain, true);
    expect(json.tiers).toEqual({ sm: null, md: FLASH, lg: null });
    expect(json).not.toHaveProperty('models');
  });

  it('editing reads the endpoint back into the form', () => {
    const e = new LLMEndpoint({ name: 'org', tiers: { sm: FLASH }, models: [FLASH, PRO] } as never);
    const draft = draftFrom(e, 'root');
    expect(draft.tiers).toEqual({ sm: FLASH, md: null, lg: null });
    expect(catalogFromText(draft.models)).toEqual([FLASH, PRO]);
  });

  it('the resolved sizes come from the hub expansion', () => {
    const e = new LLMEndpoint({ name: 'me' } as never);
    e.expand = { tiers: { sm: FLASH, md: null } };
    expect(e.effectiveTiers).toEqual({ sm: FLASH, md: null, lg: null });
  });
});

describe('LLM preferences', () => {
  it('default size and source order are surfaced under their own category', () => {
    const llm = getSurfacedPrefInfos().filter((info) => info.category === 'llm');
    expect(llm.map((info) => info.key)).toEqual([PrefKey.LLM_DEFAULT_SIZE, PrefKey.LLM_SOURCE_ORDER]);
    expect(PREF_CATEGORIES).toContain('llm');
    expect(llm[0].defaultValue).toBe('md');
    expect(llm[1].defaultValue).toBe('device,api_key,endpoint');
  });
});
