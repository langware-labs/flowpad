import pytest

from tests.conftest import async_context
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity


class SomeDBClass(Entity):
    type: str = APIField(default="somedbclass")
    foo: str
    none_db_foo: str | None = None
    _private_foo: str | None = None

    def __init__(self, **data):
        super().__init__(**data)
        self.exclude_from_db("none_db_foo")


class SpaceEntity(Entity):
    type: str = APIField(default="space")
    name: str


class PageEntity(Entity):
    type: str = APIField(default="t_page")
    title: str


class FlowEntity(Entity):
    type: str = APIField(default="test_flow_entity")
    content: str


# TODO fix execution context


def test_db_field_inclusion():
    some_instance = SomeDBClass(foo="bar")
    fields_names = some_instance.get_db_fields_attribute_names()
    assert "foo" in fields_names
    assert "none_db_foo" not in fields_names
    assert "_private_foo" not in fields_names


@async_context
async def test_basic_dirty():
    some_instance = SomeDBClass(foo="bar")
    assert some_instance.dirty is True
    await some_instance.save()
    assert some_instance.dirty is False
    some_instance.foo = "baz"
    assert some_instance.dirty is True
    await some_instance.save()
    assert some_instance.dirty is False


@async_context
async def test_get_dependencies():
    some_instance = SomeDBClass(foo="foo")
    await some_instance.save()
    some_instance2 = SomeDBClass(foo="bar")
    await some_instance2.save()
    await some_instance.add_dependency(some_instance2)

    dependencies = await some_instance.get_dependencies()
    assert len(dependencies) == 1
    assert dependencies[0] == some_instance2.typeid
    dependencies2 = await some_instance2.get_dependencies()
    assert len(dependencies2) == 0

    await some_instance.remove_dependency(some_instance2)

    dependencies = await some_instance.get_dependencies()
    assert len(dependencies) == 0
    dependencies2 = await some_instance2.get_dependencies()
    assert len(dependencies2) == 0


@async_context
async def test_get_dependents():
    some_instance = SomeDBClass(foo="foo")
    await some_instance.save()
    some_instance2 = SomeDBClass(foo="bar")
    await some_instance2.save()
    await some_instance.add_dependency(some_instance2)

    dependents = await some_instance.get_dependents()
    assert len(dependents) == 0
    dependents2 = await some_instance2.get_dependents()
    assert len(dependents2) == 1
    assert dependents2[0] == some_instance.typeid

    await some_instance.remove_dependency(some_instance2)

    dependents = await some_instance.get_dependents()
    assert len(dependents) == 0
    dependents2 = await some_instance2.get_dependents()
    assert len(dependents2) == 0


@async_context
async def test_get_ancestor_direct():
    """Test getting direct ancestor"""
    space = SpaceEntity(name="Test Space")
    await space.save()

    page = PageEntity(title="Test Page")
    await page.save()
    await space.add_child(page)

    # Test getting direct ancestor
    ancestor = await SpaceEntity.get_ancestor(page.typeid)
    assert ancestor is not None
    assert ancestor.id == space.id
    assert SpaceEntity.is_entity(ancestor)
    assert ancestor.name == "Test Space"


@async_context
async def test_get_ancestor_longer_path():
    """Test getting ancestor with longer path: space -> page -> flow"""
    space = SpaceEntity(name="Test Space")
    await space.save()

    page = PageEntity(title="Test Page")
    await page.save()
    await space.add_child(page)

    flow = FlowEntity(content="Test Flow")
    await flow.save()
    await page.add_child(flow)

    # Test getting space ancestor from flow (2 levels up)
    ancestor = await SpaceEntity.get_ancestor(flow.typeid)
    assert ancestor is not None
    assert ancestor.id == space.id
    assert SpaceEntity.is_entity(ancestor)
    assert ancestor.name == "Test Space"

    # Test getting page ancestor from flow (1 level up)
    page_ancestor = await PageEntity.get_ancestor(flow.typeid)
    assert page_ancestor is not None
    assert page_ancestor.id == page.id
    assert PageEntity.is_entity(page_ancestor)
    assert page_ancestor.title == "Test Page"


@async_context
async def test_get_ancestor_two_types_return_first():
    """Test that when two ancestor types exist, the first one is returned"""
    space = SpaceEntity(name="Test Space")
    await space.save()

    page1 = PageEntity(title="Parent Page")
    await page1.save()
    await space.add_child(page1)

    page2 = PageEntity(title="Child Page")
    await page2.save()
    await page1.add_child(page2)

    flow = FlowEntity(content="Test Flow")
    await flow.save()
    await page2.add_child(flow)

    # There are two-page ancestors: page2 (direct) and page1 (further up)
    # Should return page2 (the first/the closest one)
    ancestor = await PageEntity.get_ancestor(flow.typeid)
    assert ancestor is not None
    assert ancestor.id == page2.id
    assert PageEntity.is_entity(ancestor)
    assert ancestor.title == "Child Page"


@async_context
async def test_get_ancestor_no_match():
    """Test getting ancestor when no match exists"""
    page = PageEntity(title="Test Page")
    await page.save()

    flow = FlowEntity(content="Test Flow")
    await flow.save()
    await page.add_child(flow)

    # No space ancestor exists
    ancestor = await SpaceEntity.get_ancestor(flow.typeid)
    assert ancestor is None


@async_context
async def test_get_ancestor_any_type():
    """Test getting first ancestor of any type"""
    space = SpaceEntity(name="Test Space")
    await space.save()

    page = PageEntity(title="Test Page")
    await page.save()
    await space.add_child(page)

    # Get any ancestor (should return page since it's the direct parent)
    ancestor = await SpaceEntity.get_ancestor(page.typeid)
    assert ancestor is not None
    assert ancestor.id == space.id


if __name__ == "__main__":
    pytest.main()
