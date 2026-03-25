import { PAGE_TYPE, QueryFilter } from '@sdk';

import { describe, expect, it } from 'vitest';

const queryOr = new QueryFilter({
  expand: ['permissions', 'auth_scopes'],
  match: {
    op: '$OR',
    operands: [
      {
        op: '$IN',
        operands: [
          PAGE_TYPE.TEMPLATE,
          {
            op: '$PROP',
            operands: ['tags'],
          },
        ],
      },
      {
        op: '$EQ',
        operands: [
          'page',
          {
            op: '$PROP',
            operands: ['type'],
          },
        ],
      },
    ],
  },
});

const queryRegularPages = new QueryFilter({
  expand: ['permissions', 'auth_scopes'],
  match: {
    op: '$AND',
    operands: [
      {
        op: '$NIN',
        operands: [
          PAGE_TYPE.TEMPLATE,
          {
            op: '$PROP',
            operands: ['tags'],
          },
        ],
      },
      {
        op: '$NIN',
        operands: [
          PAGE_TYPE.KNOWLEDGE_HUB,
          {
            op: '$PROP',
            operands: ['tags'],
          },
        ],
      },
      {
        op: '$NIN',
        operands: [
          PAGE_TYPE.LANDING,
          {
            op: '$PROP',
            operands: ['tags'],
          },
        ],
      },
    ],
  },
});

const templatesQueryFilter = new QueryFilter({
  expand: ['permissions'],
  match: {
    op: '$IN',
    operands: [
      PAGE_TYPE.TEMPLATE,
      {
        op: '$PROP',
        operands: ['tags'],
      },
    ],
  },
});

const knowledgeHubQuery = new QueryFilter({
  expand: ['permissions', 'auth_scopes'],
  match: {
    op: '$IN',
    operands: [
      PAGE_TYPE.KNOWLEDGE_HUB,
      {
        op: '$PROP',
        operands: ['tags'],
      },
    ],
  },
});

describe('QueryFilter validation tests', () => {
  it('Case 1: Validate with AND and NIN operations', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
    };

    expect(queryRegularPages.validate(data)).toBe(true);
  });

  it('Case 2: Validate with AND and NIN operations', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
    };

    expect(queryRegularPages.validate(data)).toBe(true);
  });

  it('Case 3: Validate with IN and PROP operation', () => {
    const data = {
      type: 'page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['knowledge_hub'],
    };

    expect(knowledgeHubQuery.validate(data)).toBe(true);
  });

  it('Case 4: Validate with IN and PROP operation (data matches)', () => {
    const data = {
      type: 'page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['knowledge_hub'],
    };

    expect(knowledgeHubQuery.validate(data)).toBe(true);
  });

  it('Case 5: Validate with IN and PROP operation (data does not match)', () => {
    const data = {
      type: 'page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['different_tag'],
    };

    expect(knowledgeHubQuery.validate(data)).toBe(false);
  });

  it('Case 6: Validate with OR operation (one condition matches)', () => {
    const data = {
      type: 'page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['knowledge_hub'],
    };

    expect(queryOr.validate(data)).toBe(true); // At least one condition is true (IN operation)
  });

  it('Case 7: Validate with OR operation (no condition matches)', () => {
    const data = {
      type: 'non-page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['different_tag'],
    };

    expect(queryOr.validate(data)).toBe(false); // No condition is true
  });

  it('Case 8: Validate with EQ operation (field equals value)', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
    };
    const query = new QueryFilter({
      match: {
        op: '$EQ',
        operands: ['type', 'page'],
      },
    });

    const queryFilter = new QueryFilter(query);
    expect(queryFilter.validate(data)).toBe(true); // 'type' is 'page', so it should pass.
  });

  it('Case 9: Validate with GT operation (field greater than value)', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
      version: 2,
    };
    const query = new QueryFilter({
      match: {
        op: '$GT',
        operands: ['version', 1],
      },
    });

    const queryFilter = new QueryFilter(query);
    expect(queryFilter.validate(data)).toBe(true); // 'version' is greater than 1, so it should pass.
  });

  it('Case 10: Validate with LT operation (field less than value)', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
      version: 2,
    };
    const query = new QueryFilter({
      match: {
        op: '$LT',
        operands: ['version', 3],
      },
    });

    const queryFilter = new QueryFilter(query);
    expect(queryFilter.validate(data)).toBe(true); // 'version' is less than 3, so it should pass.
  });

  it('Case 11: Validate with LT operation (field not less than value)', () => {
    const data = {
      type: 'page',
      id: '8d579804-2d0f-4b26-ba62-df3d51336417',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:32:50.326275Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:32:50.326275Z',
      title: 'Page Title non tags',
      tags: [],
      version: 3,
    };
    const query = new QueryFilter({
      match: {
        op: '$LT',
        operands: ['version', 2],
      },
    });
    const queryFilter = new QueryFilter(query);
    expect(queryFilter.validate(data)).toBe(false); // 'version' is not less than 2, so it should fail.
  });

  it('Case 9: Validate with tag template (non-matching)', () => {
    const data = {
      type: 'page',
      id: '932ca90a-0c89-4f84-a569-92c3d08f375e',
      created_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      created_date: '2025-03-04T13:33:06.932797Z',
      updated_by: '0059480f-e13d-4337-9313-7f467b31f5ac',
      updated_date: '2025-03-04T13:33:06.932797Z',
      title: 'Page Title',
      tags: ['knowledge_hub'],
    };

    expect(templatesQueryFilter.validate(data)).toBe(false); // The 'tags' array does not contain 'template'
  });
});
