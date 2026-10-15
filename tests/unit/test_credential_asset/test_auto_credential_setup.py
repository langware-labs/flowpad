"""Auto setup reuses the normal credential writer and matches exact variable names."""
import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_service import CredentialError, save_credential

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


async def _save(key, name='', value=''):
    return await save_credential(scope='user', auto_declare=True,
                                 manifest={'name': name, 'vars': {key: {}}}, values={key: value})


async def test_matches_template_and_reuses_existing_credential(home, catalogue):
    catalogue('whatsapp')
    first = await _save('FLOW_WHATSAPP_TOKEN', value='first')
    second = await _save('FLOW_WHATSAPP_SECRET', value='second')
    assert first.name == 'whatsapp' and first.id == second.id
    assert set(second.vars) == {'FLOW_WHATSAPP_TOKEN', 'FLOW_WHATSAPP_SECRET', 'FLOW_WHATSAPP_WEBHOOK_URL'}
    assert dotenv_values(home / '.env.local')['FLOW_WHATSAPP_TOKEN'] == 'first'


async def test_custom_keys_group_without_losing_details_or_values(home, catalogue):
    catalogue()
    first = await _save('CLIENT', 'my-service', 'client-id')
    second = await _save('SECRET', 'my-service', 'secret-value')
    again = await _save('CLIENT')
    assert first.id == second.id == again.id
    assert set(again.vars) == {'CLIENT', 'SECRET'}
    assert dotenv_values(home / '.env.local') == {'CLIENT': 'client-id', 'SECRET': 'secret-value'}


async def test_unknown_key_creates_its_own_credential_without_rewriting_value(home, catalogue):
    catalogue()
    (home / '.env.local').write_text('CUSTOM_TOKEN=existing\n')
    first = await _save('CUSTOM_TOKEN')
    second = await _save('CUSTOM_TOKEN', value='updated')
    assert first.name == 'custom-token' and first.id == second.id
    assert dotenv_values(home / '.env.local') == {'CUSTOM_TOKEN': 'updated'}


async def test_cannot_reassign_a_key_to_a_different_credential(home, catalogue):
    catalogue()
    await _save('CLIENT', 'original')
    with pytest.raises(CredentialError, match='already belongs to original'):
        await _save('CLIENT', 'other')


async def test_template_match_extends_an_existing_credential_by_name(home, catalogue):
    catalogue()
    first = await _save('FLOW_WHATSAPP_TOKEN', 'whatsapp', 'token')
    catalogue('whatsapp')
    second = await _save('FLOW_WHATSAPP_SECRET', value='secret')
    assert first.id == second.id
    assert set(second.vars) == {'FLOW_WHATSAPP_TOKEN', 'FLOW_WHATSAPP_SECRET'}


async def test_same_name_in_another_scope_is_not_updated(home, project, catalogue):
    catalogue()
    user = await _save('CLIENT', 'service', 'personal')
    own = await save_credential(scope='project', project_id=str(project.id), auto_declare=True,
                                manifest={'name': 'service', 'vars': {'CLIENT': {}}}, values={'CLIENT': 'project'})
    assert user.id != own.id and own.scope == 'project'
    assert dotenv_values(home / '.env.local')['CLIENT'] == 'personal'


async def test_variable_details_merge_without_erasing_template_or_secret(home, catalogue):
    catalogue('whatsapp')
    first = await _save('FLOW_WHATSAPP_TOKEN', value='token')
    updated = await save_credential(scope='user', auto_declare=True,
        manifest={'name': '', 'vars': {'FLOW_WHATSAPP_TOKEN': {
            'label': 'My token', 'hint': 'From Meta', 'required': 'OPTIONAL',
            'secret': False, 'pattern': '^token', 'help_url': 'https://example.com/help',
        }}})
    assert updated.id == first.id and updated.title == first.title
    var = updated.vars['FLOW_WHATSAPP_TOKEN']
    assert (var.label, var.hint, var.secret, var.pattern) == ('My token', 'From Meta', False, '^token')
    assert str(var.required) == 'OPTIONAL' and var.help_url == 'https://example.com/help'
    assert 'FLOW_WHATSAPP_SECRET' in updated.vars
    assert dotenv_values(home / '.env.local')['FLOW_WHATSAPP_TOKEN'] == 'token'
    unchanged = await _save('FLOW_WHATSAPP_TOKEN')
    assert unchanged.vars['FLOW_WHATSAPP_TOKEN'].label == 'My token'


async def test_details_can_be_saved_when_creating_a_credential(home, catalogue):
    catalogue()
    spec = await save_credential(scope='user', auto_declare=True,
        manifest={'name': '', 'vars': {'CUSTOM_KEY': {'label': 'Custom key', 'secret': False}}})
    assert spec.vars['CUSTOM_KEY'].label == 'Custom key'
    assert spec.vars['CUSTOM_KEY'].secret is False
