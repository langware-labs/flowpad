import { ApiUrl, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';

// Sample UUIDv4s for testing
const WORKSPACE_ID = '123e4567-e89b-4456-8abc-def123456789';
const FOLDER_ID = '987fcdeb-89ab-4456-8abc-def123456789';

describe('ApiUrl', () => {
  describe('constructor', () => {
    it('should create instance with default values', () => {
      const apiUrl = new ApiUrl();
      expect(apiUrl.method).toBe('GET');
      expect(apiUrl.prefix).toBe('/graph');
      expect(apiUrl.targetEntityTypeId).toBeNull();
    });

    it('should set graph prefix when useGraphPrefix is false', () => {
      const apiUrl = new ApiUrl('GET', false);
      expect(apiUrl.prefix).toBe('');
    });
  });

  describe('property accessors', () => {
    it('should set HTTP method', () => {
      const apiUrl = new ApiUrl();
      apiUrl.method = 'POST';
      expect(apiUrl.method).toBe('POST');
    });

    it('should set target entity', () => {
      const apiUrl = new ApiUrl();
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      expect(apiUrl.targetEntityTypeId?.type).toBe('workspace');
      expect(apiUrl.targetEntityTypeId?.id).toBe(WORKSPACE_ID);
      expect(apiUrl.scope).toHaveLength(0);
    });

    it('should set scope entities', () => {
      const apiUrl = new ApiUrl();
      apiUrl.scope = [new TypeId('workspace', WORKSPACE_ID)];
      apiUrl.targetEntityTypeId = new TypeId('folder', FOLDER_ID);

      expect(apiUrl.targetEntityTypeId?.type).toBe('folder');
      expect(apiUrl.targetEntityTypeId?.id).toBe(FOLDER_ID);
      expect(apiUrl.scope).toHaveLength(1);
      expect(apiUrl.scope[0].type).toBe('workspace');
      expect(apiUrl.scope[0].id).toBe(WORKSPACE_ID);
    });

    it('should set action', () => {
      const apiUrl = new ApiUrl();
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      apiUrl.action = 'list';

      expect(apiUrl.toString()).toContain('/workspace/');
      expect(apiUrl.toString()).toContain('/list');
    });

    it('should set request parameters', () => {
      const apiUrl = new ApiUrl();
      const params = { expand: true, limit: 10 };
      apiUrl.queryParameters = params;

      expect(apiUrl.toString()).toContain('expand=true');
      expect(apiUrl.toString()).toContain('limit=10');
    });
  });

  describe('URL generation', () => {
    it('should generate URL with scope and target', () => {
      const apiUrl = new ApiUrl();
      apiUrl.scope = [new TypeId('workspace', WORKSPACE_ID)];
      apiUrl.targetEntityTypeId = new TypeId('folder', FOLDER_ID);

      const url = apiUrl.toString();
      expect(url).toContain(`/workspace/${WORKSPACE_ID}`);
      expect(url).toContain(`/folder/${FOLDER_ID}`);
    });
  });

  describe('toString', () => {
    it('should generate URL for simple entity path', () => {
      const apiUrl = new ApiUrl();
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}`);
    });

    it('should generate URL with scope even without target', () => {
      const apiUrl = new ApiUrl();
      apiUrl.action = 'sync';
      apiUrl.directResourceType = 'task';
      apiUrl.scope = [new TypeId('workspace', WORKSPACE_ID)];
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}/task/sync`);
    });

    it('should generate URL with nested entities', () => {
      const apiUrl = new ApiUrl();
      apiUrl.scope = [new TypeId('workspace', WORKSPACE_ID)];
      apiUrl.targetEntityTypeId = new TypeId('folder', FOLDER_ID);
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}/folder/${FOLDER_ID}`);
    });

    it('should generate URL with action', () => {
      const apiUrl = new ApiUrl();
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      apiUrl.action = 'list';
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}/list`);
    });

    it('should generate URL with query parameters', () => {
      const apiUrl = new ApiUrl();
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      apiUrl.action = 'list';
      apiUrl.queryParameters = { expand: true, limit: 10 };
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}/list?expand=true&limit=10`);
    });

    it('should generate URL with graph prefix', () => {
      const apiUrl = new ApiUrl('GET', true);
      apiUrl.targetEntityTypeId = new TypeId('workspace', WORKSPACE_ID);
      expect(apiUrl.toString()).toBe(`/graph/workspace/${WORKSPACE_ID}`);
    });
  });

  describe('HTTP method checks', () => {
    it('should identify POST method', () => {
      const apiUrl = new ApiUrl();
      apiUrl.method = 'POST';
      expect(apiUrl.method).toBe('POST');
    });

    it('should identify GET method', () => {
      const apiUrl = new ApiUrl();
      expect(apiUrl.method).toBe('GET');
    });
  });

  describe('request parameters', () => {
    it('should set and chain request parameters', () => {
      const apiUrl = new ApiUrl();
      const params = { expand: true, limit: 10 };
      apiUrl.queryParameters = params;
      expect(apiUrl.queryParameters).toBe(params); // Test method chaining
      expect(apiUrl.toString()).toBe('/graph?expand=true&limit=10');
    });
  });
});
