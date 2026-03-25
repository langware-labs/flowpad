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

    it('should cast TypeId arrays when using dataManager deepAssign', () => {
      // Step 1: Define an entity-like object with various TypeId formats in scope
      const uuid1 = '123e4567-e89b-41d4-a456-426614174000';
      const uuid2 = '987fcdeb-51d3-41d4-a456-426614174999';

      // Create a mock entity JSON with scope containing all TypeId formats
      const mockEntityJson = {
        type: 'test_entity',
        id: uuid1,
        name: 'Test Entity',
        // Scope array with all TypeId formats as strings (as they come from API)
        scope: [
          `workspace-${uuid2}`, // UUID format
          'workspace-SPACE-0', // Namespace format (namespace-index)
          'user-name.john_doe', // Prop ID format (property.value)
          'agent-@local', // Named ID format (@name)
        ],
      };

      // Step 2: Create target object to deep assign into
      const targetObject: any = {};

      // Step 3: Use dataManager deepAssign to cast TypeIds
      dataManager.deepAssign(targetObject, mockEntityJson);

      // Step 4: Validate that id was properly assigned
      expect(targetObject.id).toBe(uuid1);
      expect(targetObject.name).toBe('Test Entity');
      expect(targetObject.type).toBe('test_entity');

      // Step 5: Validate that scope array has all elements as TypeId class instances
      expect(targetObject.scope).toBeDefined();
      expect(Array.isArray(targetObject.scope)).toBe(true);
      expect(targetObject.scope).toHaveLength(4);

      // Validate each TypeId in scope is properly cast
      // 1. UUID format
      expect(targetObject.scope[0]).toBeInstanceOf(TypeId);
      expect(targetObject.scope[0].type).toBe('workspace');
      expect(targetObject.scope[0].id).toBe(uuid2);
      expect(targetObject.scope[0].identifierType).toBe(IdentifierType.UUID);

      // 2. Namespace format
      expect(targetObject.scope[1]).toBeInstanceOf(TypeId);
      expect(targetObject.scope[1].type).toBe('workspace');
      expect(targetObject.scope[1].id).toBe('SPACE-0');
      expect(targetObject.scope[1].identifierType).toBe(IdentifierType.NAMESPACE);

      // 3. Prop ID format
      expect(targetObject.scope[2]).toBeInstanceOf(TypeId);
      expect(targetObject.scope[2].type).toBe('user');
      expect(targetObject.scope[2].id).toBe('name.john_doe');
      expect(targetObject.scope[2].identifierType).toBe(IdentifierType.PROP_ID);

      // 4. Named ID format
      expect(targetObject.scope[3]).toBeInstanceOf(TypeId);
      expect(targetObject.scope[3].type).toBe('agent');
      expect(targetObject.scope[3].id).toBe('@local');
      expect(targetObject.scope[3].identifierType).toBe(IdentifierType.NAMED);
    });

    it('should handle nested TypeId arrays in entity expansion', () => {
      const uuid1 = '111e4567-e89b-41d4-a456-426614174111';
      const uuid2 = '222fcdeb-51d3-41d4-a456-426614174222';

      // Mock entity with nested TypeId arrays in expand.auth_scopes
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

      // Validate nested TypeId arrays are properly cast
      expect(targetObject.expand).toBeDefined();
      expect(targetObject.expand.auth_scopes).toBeDefined();
      expect(Array.isArray(targetObject.expand.auth_scopes)).toBe(true);
      expect(targetObject.expand.auth_scopes).toHaveLength(2);

      // First scope array
      expect(Array.isArray(targetObject.expand.auth_scopes[0])).toBe(true);
      expect(targetObject.expand.auth_scopes[0]).toHaveLength(2);
      expect(targetObject.expand.auth_scopes[0][0]).toBeInstanceOf(TypeId);
      expect(targetObject.expand.auth_scopes[0][0].type).toBe('workspace');
      expect(targetObject.expand.auth_scopes[0][0].id).toBe(uuid2);

      expect(targetObject.expand.auth_scopes[0][1]).toBeInstanceOf(TypeId);
      expect(targetObject.expand.auth_scopes[0][1].type).toBe('folder');
      expect(targetObject.expand.auth_scopes[0][1].id).toBe('FOLDER-123');

      // Second scope array
      expect(Array.isArray(targetObject.expand.auth_scopes[1])).toBe(true);
      expect(targetObject.expand.auth_scopes[1]).toHaveLength(2);
      expect(targetObject.expand.auth_scopes[1][0]).toBeInstanceOf(TypeId);
      expect(targetObject.expand.auth_scopes[1][0].type).toBe('page');
      expect(targetObject.expand.auth_scopes[1][0].id).toBe('name.my_page');

      expect(targetObject.expand.auth_scopes[1][1]).toBeInstanceOf(TypeId);
      expect(targetObject.expand.auth_scopes[1][1].type).toBe('user');
      expect(targetObject.expand.auth_scopes[1][1].id).toBe('@me');
    });
  });
});
