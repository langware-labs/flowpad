import tempfile
from typing import Annotated, Optional

from fastapi import UploadFile

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import FullTextSearch
from flow_sdk.db.relationship_model import Relationship
from flow_sdk.responses import ApiSuccessResponse
def file_hash(path):
    """File hash function."""
    import hashlib
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


class TEntity(Entity):
    type: str = APIField(default="tentity")
    test_data: str | None = APIField(None)
    test_fulltext: Annotated[Optional[str], FullTextSearch] = APIField(None)
    none_api_field: str | None = "this is sodded"
    blob_field: str | None = APIField(None, blob=True)

    @action.all()
    def get_data(self):
        return ApiSuccessResponse(data=f"Instance data: {self.test_data}")

    @action.all()
    def action_with_parameter(self, param: str):
        return ApiSuccessResponse(data={"param": param})

    @action.all()
    async def attach_test(self, param: str, uploaded_file: UploadFile):
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_file_name = temp_file.name
            # Write the uploaded file's content to the temporary file
            content = await uploaded_file.read()
            temp_file.write(content)
        file_sha256 = file_hash(temp_file_name)
        return ApiSuccessResponse(data={"param": param, "hash": file_sha256})

    @classmethod
    @action.all()
    def get_class_data(cls):
        return ApiSuccessResponse(data="Class data: " + cls.__name__)


class TRelationship(Relationship):
    type: str = APIField(default="trelationship")
    test_data: str | None = None
    test_fulltext: Annotated[Optional[str], FullTextSearch] = None
