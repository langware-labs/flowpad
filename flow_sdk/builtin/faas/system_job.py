import hashlib
import random
import string
from typing import ClassVar

from flow_sdk.builtin.faas import Job
from flow_sdk.core import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.builtin.enums.job_enums import JobDeploymentStatus


class SystemJob(Job):
    type: str = BuiltinEntityType.SYSTEM_JOB.value
    _api_visible = False  # Do not change to true, security risk—this is a system job
    allowed_api_execution: bool = False
    _unique: ClassVar[list[str]] = ["job_name"]

    @classmethod
    async def get_system_job_by_name(cls, name: str) -> Job | None:
        expression_node = ExpressionNode(
            op=QueryOp.AND,
            operands=[
                ExpressionNode(op=QueryOp.EQ, operands=["allowed_api_execution", True]),
                ExpressionNode(op=QueryOp.EQ, operands=["job_name", name]),
            ],
        )
        entities_filter = QueryFilter(type=BuiltinEntityType.SYSTEM_JOB.value, match=expression_node)
        system_job = await super().get_all(entities_filter=entities_filter)
        system_job = [j for j in system_job if isinstance(j, SystemJob)]
        if not system_job:
            return None
        if len(system_job) > 1:
            raise ValueError(f"Multiple system jobs found with name '{name}'")
        return system_job[0]

    def to_api_job(self) -> Job:
        """Convert to API job format"""
        return Job(
            id=self.generate_hashed_uuid(),
            job_name=self.job_name,
            job_description=self.job_description,
            deployment_status=JobDeploymentStatus.DEPLOYED,
            job_type=self.job_type,
        )

    @staticmethod
    def _generate_seed(length: int = 8) -> str:
        """Generate a random alphanumeric seed."""
        return "".join(random.choices(string.ascii_letters + string.digits, k=length))

    @staticmethod
    def _format_as_uuid_v4(hex_str: str) -> str:
        """
        Format a 32-character hex string as UUID v4.
        Ensures version and variant bits are properly set.
        """
        hex_str = list(hex_str.lower())

        # Set version to 4 (UUID v4)
        hex_str[12] = "4"

        # Set variant (first two bits 10xx, i.e. 8, 9, a, or b)
        variant_char = hex_str[16]
        variant_int = int(variant_char, 16)
        variant_int = (variant_int & 0x3) | 0x8  # force leading bits to 10
        hex_str[16] = f"{variant_int:x}"

        # Format UUID-like string
        return (
            "".join(hex_str[0:8])
            + "-"
            + "".join(hex_str[8:12])
            + "-"
            + "".join(hex_str[12:16])
            + "-"
            + "".join(hex_str[16:20])
            + "-"
            + "".join(hex_str[20:32])
        )

    def _hash_uuid_with_seed(self, seed: str = "lDSvDzS4") -> str:
        """
        Combine existing UUID and seed, return a UUID v4-compatible hashed UUID.
        """
        combined = f"{self.id}-{seed}".encode("utf-8")
        hashed = hashlib.sha256(combined).hexdigest()  # 64 chars
        return self._format_as_uuid_v4(hashed)

    def generate_hashed_uuid(self) -> str:
        """
        Generate a hashed UUID based on an existing UUID + random seed.
        Returns the hashed UUID-like string for potential reversion.

        Returns:
            (hashed_uuid, seed)
        """
        return self._hash_uuid_with_seed()
