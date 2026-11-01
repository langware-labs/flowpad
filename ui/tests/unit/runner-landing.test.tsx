import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { dataManager } from '@sdk';
import ServiceEndpointLanding from '@src/pages/entry/ServiceEndpointLanding';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('offers the open door by id without reading the protected endpoint record', () => {
  const get = vi.spyOn(dataManager, 'getByTypeId').mockRejectedValue(new Error('Reader required'));
  const id = '91c340cb-a2cc-4f67-9fe1-f2a0e481a0e3';
  render(<MemoryRouter initialEntries={[`/service_endpoint/${id}`]}><Routes><Route path="/service_endpoint/:endpointId" element={<ServiceEndpointLanding />} /></Routes></MemoryRouter>);
  expect(screen.getByRole('link', {name:'Open app'}).getAttribute('href')).toMatch(new RegExp(`/service_endpoint/${id}/open$`));
  expect(get).not.toHaveBeenCalled();
});
