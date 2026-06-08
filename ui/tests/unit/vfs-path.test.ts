import { TypeId, VFSPath, VFS_PROTOCOL } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('VFSPath', () => {
  describe('parse - basic functionality', () => {
    it('should parse path with vfs:// protocol', () => {
      const vpath = VFSPath.parse('vfs://compute_node-6bc04758-6594-47bc-9545-1383eff24446/Users/test/file.md');

      expect(vpath.type).toBe('compute_node');
      expect(vpath.id).toBe('6bc04758-6594-47bc-9545-1383eff24446');
      expect(vpath.entitySubPath).toBe('Users/test/file.md');
      expect(vpath.isAbsolute).toBe(true);
    });

    it('should parse path without vfs:// protocol', () => {
      const vpath = VFSPath.parse('compute_node-6bc04758-6594-47bc-9545-1383eff24446/Users/test/file.md');

      expect(vpath.type).toBe('compute_node');
      expect(vpath.id).toBe('6bc04758-6594-47bc-9545-1383eff24446');
      expect(vpath.entitySubPath).toBe('Users/test/file.md');
      expect(vpath.isAbsolute).toBe(true);
    });

    it('should handle null input', () => {
      const vpath = VFSPath.parse(null);

      expect(vpath.type).toBeNull();
      expect(vpath.id).toBeNull();
      expect(vpath.entitySubPath).toBe('');
      expect(vpath.isAbsolute).toBe(false);
    });

    it('should handle undefined input', () => {
      const vpath = VFSPath.parse(undefined);

      expect(vpath.type).toBeNull();
      expect(vpath.id).toBeNull();
      expect(vpath.entitySubPath).toBe('');
    });

    it('should handle empty string', () => {
      const vpath = VFSPath.parse('');

      expect(vpath.type).toBeNull();
      expect(vpath.id).toBeNull();
      expect(vpath.entitySubPath).toBe('');
    });
  });

  describe('parse - different TypeId formats', () => {
    it('should parse path with UUID TypeId', () => {
      const vpath = VFSPath.parse('agent-550e8400-e29b-41d4-a716-446655440000/skills/test.md');

      expect(vpath.type).toBe('agent');
      expect(vpath.id).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(vpath.entitySubPath).toBe('skills/test.md');
      expect(vpath.typeId?.identifierType).toBe('uuid');
    });

    it('should parse path with named TypeId (@local)', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test.md');

      expect(vpath.type).toBe('agent');
      expect(vpath.id).toBe('@local');
      expect(vpath.entitySubPath).toBe('skills/test.md');
      expect(vpath.typeId?.identifierType).toBe('named');
    });

    it('should parse path with namespace TypeId', () => {
      const vpath = VFSPath.parse('workspace-WORKSPACE-123/files/doc.pdf');

      expect(vpath.type).toBe('workspace');
      expect(vpath.id).toBe('WORKSPACE-123');
      expect(vpath.entitySubPath).toBe('files/doc.pdf');
      expect(vpath.typeId?.identifierType).toBe('namespace');
    });

    it('should parse path with prop_id TypeId', () => {
      const vpath = VFSPath.parse('user-email.john_doe/documents/file.txt');

      expect(vpath.type).toBe('user');
      expect(vpath.id).toBe('email.john_doe');
      expect(vpath.entitySubPath).toBe('documents/file.txt');
      expect(vpath.typeId?.identifierType).toBe('prop_id');
    });
  });

  describe('parse - edge cases', () => {
    it('should handle TypeId without subpath', () => {
      const vpath = VFSPath.parse('agent-@local');

      expect(vpath.type).toBe('agent');
      expect(vpath.id).toBe('@local');
      expect(vpath.entitySubPath).toBe('');
      expect(vpath.isAbsolute).toBe(true);
    });

    it('should handle TypeId with trailing slash', () => {
      const vpath = VFSPath.parse('agent-@local/');

      expect(vpath.type).toBe('agent');
      expect(vpath.id).toBe('@local');
      expect(vpath.entitySubPath).toBe('');
    });

    it('should handle path with spaces', () => {
      const vpath = VFSPath.parse('compute_node-@local/Users/test/My Documents/file.md');

      expect(vpath.type).toBe('compute_node');
      expect(vpath.entitySubPath).toBe('Users/test/My Documents/file.md');
    });

    it('should handle path with special characters', () => {
      const vpath = VFSPath.parse('compute_node-@local/path/file (1).md');

      expect(vpath.entitySubPath).toBe('path/file (1).md');
    });

    it('should handle relative path without TypeId', () => {
      const vpath = VFSPath.parse('/relative/path/file.md');

      expect(vpath.type).toBeNull();
      expect(vpath.id).toBeNull();
      expect(vpath.entitySubPath).toBe('/relative/path/file.md');
      expect(vpath.isAbsolute).toBe(false);
    });
  });

  describe('absVfsPath property', () => {
    it('should return path without vfs:// protocol', () => {
      const vpath = VFSPath.parse('vfs://compute_node-@local/Users/test/file.md');

      expect(vpath.absVfsPath).toBe('compute_node-@local/Users/test/file.md');
      expect(vpath.absVfsPath).not.toContain('vfs://');
    });

    it('should return consistent path regardless of input format', () => {
      const withProtocol = VFSPath.parse('vfs://agent-@local/skills/test.md');
      const withoutProtocol = VFSPath.parse('agent-@local/skills/test.md');

      expect(withProtocol.absVfsPath).toBe(withoutProtocol.absVfsPath);
      expect(withProtocol.absVfsPath).toBe('agent-@local/skills/test.md');
    });

    it('should include trailing slash for root paths', () => {
      const vpath = VFSPath.parse('agent-@local');

      expect(vpath.absVfsPath).toBe('agent-@local/');
    });

    it('should return just subpath when no TypeId', () => {
      const vpath = VFSPath.parse('/some/relative/path');

      expect(vpath.absVfsPath).toBe('/some/relative/path');
    });
  });

  describe('uri property', () => {
    it('should return path with vfs:// protocol', () => {
      const vpath = VFSPath.parse('compute_node-@local/Users/test/file.md');

      expect(vpath.uri).toBe('vfs://compute_node-@local/Users/test/file.md');
      expect(vpath.uri).toContain('vfs://');
    });

    it('should be idempotent when input already has protocol', () => {
      const vpath = VFSPath.parse('vfs://agent-@local/skills/test.md');

      expect(vpath.uri).toBe('vfs://agent-@local/skills/test.md');
      // Should not have double protocol
      expect(vpath.uri).not.toContain('vfs://vfs://');
    });
  });

  describe('typeId property', () => {
    it('should return valid TypeId when path has TypeId prefix', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test.md');
      const typeId = vpath.typeId;

      expect(typeId).not.toBeNull();
      expect(typeId).toBeInstanceOf(TypeId);
      expect(typeId?.type).toBe('agent');
      expect(typeId?.id).toBe('@local');
    });

    it('should return null when path has no TypeId', () => {
      const vpath = VFSPath.parse('/relative/path');

      expect(vpath.typeId).toBeNull();
    });
  });

  describe('filename property', () => {
    it('should extract filename from path', () => {
      const vpath = VFSPath.parse('agent-@local/skills/my-skill/SKILL.md');

      expect(vpath.filename).toBe('SKILL.md');
    });

    it('should return empty string for directory path', () => {
      const vpath = VFSPath.parse('agent-@local/skills/');

      expect(vpath.filename).toBe('');
    });

    it('should handle root path', () => {
      const vpath = VFSPath.parse('agent-@local');

      expect(vpath.filename).toBe('');
    });
  });

  describe('parent property', () => {
    it('should return parent directory VFSPath', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test/file.md');
      const parent = vpath.parent;

      expect(parent.entitySubPath).toBe('skills/test');
      expect(parent.type).toBe('agent');
      expect(parent.id).toBe('@local');
    });

    it('should return root when at first level', () => {
      const vpath = VFSPath.parse('agent-@local/file.md');
      const parent = vpath.parent;

      expect(parent.entitySubPath).toBe('');
      expect(parent.type).toBe('agent');
    });

    it('should return self when already at root', () => {
      const vpath = VFSPath.parse('agent-@local');
      const parent = vpath.parent;

      expect(parent.absVfsPath).toBe(vpath.absVfsPath);
    });
  });

  describe('fromTypeId static method', () => {
    it('should create VFSPath from TypeId and path', () => {
      const typeId = new TypeId('agent', '@local');
      const vpath = VFSPath.fromTypeId(typeId, 'skills/test.md');

      expect(vpath.type).toBe('agent');
      expect(vpath.id).toBe('@local');
      expect(vpath.entitySubPath).toBe('skills/test.md');
      expect(vpath.absVfsPath).toBe('agent-@local/skills/test.md');
    });

    it('should handle leading slash in path', () => {
      const typeId = new TypeId('agent', '@local');
      const vpath = VFSPath.fromTypeId(typeId, '/skills/test.md');

      expect(vpath.entitySubPath).toBe('skills/test.md');
      expect(vpath.absVfsPath).toBe('agent-@local/skills/test.md');
    });

    it('should handle empty path', () => {
      const typeId = new TypeId('agent', '@local');
      const vpath = VFSPath.fromTypeId(typeId);

      expect(vpath.entitySubPath).toBe('');
      expect(vpath.absVfsPath).toBe('agent-@local/');
    });
  });

  describe('startsWith method', () => {
    it('should return true when path starts with another path', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test/file.md');

      expect(vpath.startsWith('agent-@local/skills')).toBe(true);
      expect(vpath.startsWith('agent-@local')).toBe(true);
    });

    it('should return false when path does not start with another path', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test/file.md');

      expect(vpath.startsWith('agent-@local/other')).toBe(false);
      expect(vpath.startsWith('project-@local')).toBe(false);
    });

    it('should work with VFSPath argument', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test/file.md');
      const prefix = VFSPath.parse('agent-@local/skills');

      expect(vpath.startsWith(prefix)).toBe(true);
    });

    it('should normalize protocol when comparing', () => {
      const vpath = VFSPath.parse('vfs://agent-@local/skills/test.md');

      expect(vpath.startsWith('agent-@local')).toBe(true);
      expect(vpath.startsWith('vfs://agent-@local')).toBe(true);
    });
  });

  describe('equals method', () => {
    it('should return true for equal paths', () => {
      const vpath1 = VFSPath.parse('agent-@local/skills/test.md');
      const vpath2 = VFSPath.parse('agent-@local/skills/test.md');

      expect(vpath1.equals(vpath2)).toBe(true);
    });

    it('should return true regardless of protocol', () => {
      const vpath1 = VFSPath.parse('vfs://agent-@local/skills/test.md');
      const vpath2 = VFSPath.parse('agent-@local/skills/test.md');

      expect(vpath1.equals(vpath2)).toBe(true);
    });

    it('should return false for different paths', () => {
      const vpath1 = VFSPath.parse('agent-@local/skills/test.md');
      const vpath2 = VFSPath.parse('agent-@local/skills/other.md');

      expect(vpath1.equals(vpath2)).toBe(false);
    });

    it('should return false for null', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test.md');

      expect(vpath.equals(null)).toBe(false);
      expect(vpath.equals(undefined)).toBe(false);
    });
  });

  describe('toString and toJSON', () => {
    it('should return absVfsPath for toString', () => {
      const vpath = VFSPath.parse('vfs://agent-@local/skills/test.md');

      expect(vpath.toString()).toBe('agent-@local/skills/test.md');
    });

    it('should return absVfsPath for toJSON', () => {
      const vpath = VFSPath.parse('vfs://agent-@local/skills/test.md');

      expect(vpath.toJSON()).toBe('agent-@local/skills/test.md');
    });

    it('should serialize correctly in JSON.stringify', () => {
      const vpath = VFSPath.parse('agent-@local/skills/test.md');
      const json = JSON.stringify({ path: vpath });

      expect(json).toBe('{"path":"agent-@local/skills/test.md"}');
    });
  });

  describe('VFS_PROTOCOL constant', () => {
    it('should export VFS_PROTOCOL constant', () => {
      expect(VFS_PROTOCOL).toBe('vfs');
    });

    it('should match VFSPath.PROTOCOL', () => {
      expect(VFS_PROTOCOL).toBe(VFSPath.PROTOCOL);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle execute-flow URL path', () => {
      // This is the actual path from the compile bug
      const urlPath =
        'vfs://compute_node-6bc04758-6594-47bc-9545-1383eff24446/Users/alice/Flowpad workspace/.claude/skills/walla-test.md';
      const vpath = VFSPath.parse(urlPath);

      expect(vpath.type).toBe('compute_node');
      expect(vpath.id).toBe('6bc04758-6594-47bc-9545-1383eff24446');
      expect(vpath.entitySubPath).toBe('Users/alice/Flowpad workspace/.claude/skills/walla-test.md');
      expect(vpath.filename).toBe('walla-test.md');
      expect(vpath.absVfsPath).not.toContain('vfs://');
    });

    it('should match paths with and without protocol for directory tree selection', () => {
      // Root folder path (no protocol, created programmatically)
      const rootPath = 'compute_node-6bc04758-6594-47bc-9545-1383eff24446/Users/alice/Flowpad workspace/.claude/skills';

      // Selected path from URL (with protocol)
      const selectedPath =
        'vfs://compute_node-6bc04758-6594-47bc-9545-1383eff24446/Users/alice/Flowpad workspace/.claude/skills/test.md';

      const rootVpath = VFSPath.parse(rootPath);
      const selectedVpath = VFSPath.parse(selectedPath);

      // The selected path should start with the root path
      expect(selectedVpath.startsWith(rootVpath)).toBe(true);
      expect(selectedVpath.absVfsPath.startsWith(rootVpath.absVfsPath)).toBe(true);
    });
  });
});
