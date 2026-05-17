import { dataManager, IdentifierType, TypeId } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';

// Helper to generate a valid UUIDv4
function generateUUID(): string {
  return '550e8400-e29b-41d4-a716-446655440000';
}

describe('TypeId', () => {
  describe('test_str_unknown', () => {
    it('should reject unknown identifier format (stricter than backend)', () => {
      const unknownId = 'this_is_unknown_id';
      // Note: Frontend TypeId is stricter than backend - it rejects unknown formats
      // Backend allows unknown identifiers, but frontend requires valid format
      expect(() => new TypeId(`some_type${TypeId.DELIMITER}${unknownId}`)).toThrow('Invalid typeId');
    });

    it('should create TypeId with valid namespace format', () => {
      // Frontend accepts identifiers in namespace format: name-digits
      const validNamespace = 'ns-123';
      const tid = new TypeId(`some_type${TypeId.DELIMITER}${validNamespace}`);

      expect(tid.identifier).toBe(validNamespace);
      expect(tid.id).toBe(validNamespace);
      expect(tid.type).toBe('some_type');
      // This will be classified as NAMESPACE type due to the pattern match
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);
    });
  });

  describe('test_str_uuid', () => {
    it('should handle UUID identifier format', () => {
      const uid = generateUUID();
      const tid = new TypeId(`some_type${TypeId.DELIMITER}${uid}`);

      expect(tid.id).toBe(uid);
      expect(tid.type).toBe('some_type');
      expect(tid.identifierType).toBe(IdentifierType.UUID);
    });
  });

  describe('test_str_key', () => {
    it('should handle namespace key identifier format', () => {
      const namespace = 'ns';
      const keyIndex = '123';
      const key = `${namespace}-${keyIndex}`;
      const tid = new TypeId(`some_type${TypeId.DELIMITER}${key}`);

      expect(tid.id).toBe(key);
      expect(tid.type).toBe('some_type');
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);

      // Note: Frontend TypeId doesn't have namespace and key properties exposed
      // Unlike backend which has tid.namespace and tid.key
      // The identifier is stored as a single string
      expect(tid.identifier).toBe(key);
    });
  });

  describe('test_prop_id', () => {
    it('should handle property ID identifier format', () => {
      const fieldName = 'unique_name';
      const fieldValue = 'special_value';
      const propId = `${fieldName}.${fieldValue}`;
      const tid = new TypeId(`some_type${TypeId.DELIMITER}${propId}`);

      expect(tid.id).toBe(propId);
      expect(tid.type).toBe('some_type');
      expect(tid.identifierType).toBe(IdentifierType.PROP_ID);

      // Note: Frontend TypeId doesn't expose prop_id_name and prop_id_value properties
      // Unlike backend which has tid.prop_id_name and tid.prop_id_value
      // The property ID is stored as a single string
      expect(tid.identifier).toBe(propId);
    });
  });

  describe('TypeId constructor variations', () => {
    it('should create TypeId with type and id parameters', () => {
      const uid = generateUUID();
      const tid = new TypeId('some_type', uid);

      expect(tid.type).toBe('some_type');
      expect(tid.id).toBe(uid);
      expect(tid.identifierType).toBe(IdentifierType.UUID);
    });

    it('should create TypeId from string', () => {
      const uid = generateUUID();
      const tidString = `workspace${TypeId.DELIMITER}${uid}`;
      const tid = new TypeId(tidString);

      expect(tid.type).toBe('workspace');
      expect(tid.id).toBe(uid);
    });

    it('should throw error for invalid typeId string', () => {
      expect(() => new TypeId('invalid_no_delimiter')).toThrow('Invalid typeId');
    });
  });

  describe('TypeId equality and serialization', () => {
    it('should compare two TypeIds for equality', () => {
      const uid = generateUUID();
      const tid1 = new TypeId('workspace', uid);
      const tid2 = new TypeId(`workspace${TypeId.DELIMITER}${uid}`);

      expect(tid1.equals(tid2)).toBe(true);
      expect(tid1.type).toBe(tid2.type);
      expect(tid1.id).toBe(tid2.id);
    });

    it('should serialize to string correctly', () => {
      const uid = generateUUID();
      const tid = new TypeId('workspace', uid);

      expect(tid.toString()).toBe(`workspace${TypeId.DELIMITER}${uid}`);
    });

    it('should serialize to JSON correctly', () => {
      const uid = generateUUID();
      const tid = new TypeId('workspace', uid);

      expect(tid.toJSON()).toBe(`workspace${TypeId.DELIMITER}${uid}`);
    });

    it('should convert to URL string format', () => {
      const uid = generateUUID();
      const tid = new TypeId('workspace', uid);

      expect(tid.toUrlString()).toBe(`workspace/${uid}`);
    });
  });

  describe('TypeId identifier type detection', () => {
    it('should detect UUID identifier type', () => {
      const uid = generateUUID();
      const tid = new TypeId('entity', uid);
      expect(tid.identifierType).toBe(IdentifierType.UUID);
    });

    it('should detect namespace identifier type', () => {
      const tid = new TypeId('entity', 'WORKSPACE-123');
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);
    });

    it('should detect prop_id identifier type', () => {
      const tid = new TypeId('entity', 'name.john_doe');
      expect(tid.identifierType).toBe(IdentifierType.PROP_ID);
    });

    it('should detect named identifier type', () => {
      const tid = new TypeId('entity', '@local');
      expect(tid.identifierType).toBe(IdentifierType.NAMED);
    });

    it('should reject unknown identifier type (frontend is stricter)', () => {
      // Frontend TypeId rejects unknown formats, unlike backend which accepts them
      expect(() => new TypeId('entity', 'unknown_format')).toThrow('Invalid type-id');
    });
  });

  describe('TypeId number limit boundary tests', () => {
    it('should accept namespace key with number 1 (lower boundary)', () => {
      const tid = new TypeId('entity', 'ns-1');
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);
      expect(tid.id).toBe('ns-1');
    });

    it('should accept namespace key with number 9999 (just below limit)', () => {
      const tid = new TypeId('entity', 'ns-9999');
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);
      expect(tid.id).toBe('ns-9999');
    });

    it('should accept namespace key with number 10000 (at current limit)', () => {
      const tid = new TypeId('entity', 'WORKSPACE-10000');
      expect(tid.identifierType).toBe(IdentifierType.NAMESPACE);
      expect(tid.id).toBe('WORKSPACE-10000');
    });

    it('should reject namespace key with number 10001 (above current limit)', () => {
      // With current limit of 10000, this should fail
      expect(() => new TypeId('entity', 'ns-10001')).toThrow('Invalid type-id');
    });

    it('should reject namespace key with leading zeros', () => {
      expect(() => new TypeId('entity', 'ns-0123')).toThrow('Invalid type-id');
    });

    // NOTE: The pattern is designed to scale with numberLimit changes
    // If numberLimit were changed to 100000, the following would be valid:
    // - 'ns-99999' (just below limit) ✓
    // - 'ns-100000' (at limit) ✓
    // - 'ns-100001' (above limit) ✗
    // The maxDigits calculation ensures the regex adapts automatically
  });

  describe('testTypeIdArrayCasting', () => {
    beforeEach(async () => {
      // Clear dataManager cache before each test
      await dataManager.clearCache();
    });

    it('should leave string scope arrays as strings (no auto-TypeId coercion)', () => {
      const uuid1 = '123e4567-e89b-41d4-a456-426614174000';
      const uuid2 = '987fcdeb-51d3-41d4-a456-426614174999';

      const mockEntityJson = {
        type: 'test_entity',
        id: uuid1,
        name: 'Test Entity',
        scope: [
          `workspace-${uuid2}`,
          'workspace-SPACE-0',
          'user-name.john_doe',
          'agent-@local',
        ],
      };

      const targetObject: any = {};
      dataManager.deepAssign(targetObject, mockEntityJson);

      expect(targetObject.id).toBe(uuid1);
      expect(targetObject.name).toBe('Test Entity');
      expect(targetObject.type).toBe('test_entity');

      expect(targetObject.scope).toEqual(mockEntityJson.scope);
      targetObject.scope.forEach((entry: unknown) => {
        expect(typeof entry).toBe('string');
        expect(entry).not.toBeInstanceOf(TypeId);
      });
    });

    it('should leave nested auth_scopes arrays as plain strings', () => {
      const uuid1 = '111e4567-e89b-41d4-a456-426614174111';
      const uuid2 = '222fcdeb-51d3-41d4-a456-426614174222';

      const mockEntityJson = {
        type: 'page',
        id: uuid1,
        expand: {
          auth_scopes: [
            [`workspace-${uuid2}`, 'folder-FOLDER-123'],
            ['page-name.my_page', 'user-@me'],
          ],
        },
      };

      const targetObject: any = {};
      dataManager.deepAssign(targetObject, mockEntityJson);

      expect(targetObject.expand.auth_scopes).toEqual(mockEntityJson.expand.auth_scopes);
      targetObject.expand.auth_scopes.forEach((scope: unknown[]) => {
        scope.forEach((entry) => {
          expect(typeof entry).toBe('string');
          expect(entry).not.toBeInstanceOf(TypeId);
        });
      });
    });
  });
});
