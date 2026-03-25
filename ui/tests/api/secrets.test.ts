import { Agent, TypeId, EntityEnv, EnvVarType } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('Env Vars API', () => {
  const info = getTestSignupInfo();
  let agent: Agent;
  let entityTypeId: TypeId;
  let entityEnv: EntityEnv;
  const validEnvVar = {
    name: 'TEST_ENV_VAR',
    var_type: EnvVarType.API_KEY,
    description: 'Test description',
    value: 'Line1\nSecondLine',
  };

  const invalidEnvVar = {
    name: 'TEST@env@var', // lowercase, should fail
    var_type: EnvVarType.API_KEY,
    description: 'Test description',
    value: 'line1\nsecondline', // lowercase, should fail
  };

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    agent = new Agent();
    await agent.save();
    entityTypeId = new TypeId(Agent.type, agent.typeId.id);
    entityEnv = new EntityEnv(entityTypeId);
  });

  afterEach(async () => {
    // Clean up any test Env Vars
    const envVars = await entityEnv.list();
    if (envVars) {
      // Delete each env var
      for (const envVar of envVars) {
        await entityEnv.delete(envVar.name);
      }
    }
  });

  it('should create a valid env var', async () => {
    const response = await entityEnv.create(validEnvVar);
    expect(response.name).toBe(validEnvVar.name);
    expect(response.var_type).toBe(EnvVarType.API_KEY);
    expect(response.description).toBe(validEnvVar.description);
    // Value should be masked
    expect(response.value).toBeDefined();
    expect(response.value).toMatch(/^\*\*\*\*/); // Should be masked
  });

  it('should fail to create an invalid secret', async () => {
    await expect(entityEnv.create(invalidEnvVar)).rejects.toThrow();
  });

  it('should update a valid secret', async () => {
    // First create a secret
    await entityEnv.create(validEnvVar);

    // Then update it
    const response = await entityEnv.update(validEnvVar.name, {
      ...validEnvVar,
      description: 'Updated description',
      value: 'NewLine1\nSecondLine',
    });

    expect(response.name).toBe(validEnvVar.name);
    expect(response.var_type).toBe(EnvVarType.API_KEY);
    expect(response.description).toBe('Updated description');
    // Value should be masked
    expect(response.value).toBeDefined();
    expect(response.value).toMatch(/^\*\*\*\*/); // Should be masked
  });

  it('should fail to update a secret with invalid value', async () => {
    // First create a secret
    await entityEnv.create(validEnvVar);

    // Then try to update it with invalid value
    const longValue = 'a'.repeat(8_001);

    await expect(
      entityEnv.update(validEnvVar.name, {
        ...validEnvVar,
        value: longValue, // should fail due to length
      }),
    ).rejects.toThrow();
  });
});
