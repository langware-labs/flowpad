import logging
import traceback
from typing import Any

import jsonschema

# UUID v4 regex pattern - used for validation across the codebase
UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


def validate_schema_on_data(
    schema: dict[str, Any],
    data_to_validate: Any,
    force_additional_properties: bool | None = None,
    log_errors: bool = False,
) -> bool:
    original_additional_properties_val = schema.get("additionalProperties", None)
    if force_additional_properties is not None:
        schema["additionalProperties"] = force_additional_properties
    try:
        jsonschema.validate(instance=data_to_validate, schema=schema)
        return True
    except jsonschema.ValidationError as e:
        if log_errors:
            logging.error(f"Data validation error: {e}")
            logging.debug(f"Exception stack: {traceback.format_exc()}")
    except jsonschema.SchemaError as e:
        if log_errors:
            logging.error(f"Schema error: {e}")
            logging.debug(f"Exception stack: {traceback.format_exc()}")
    finally:
        if force_additional_properties is not None:
            if original_additional_properties_val is None:
                del schema["additionalProperties"]
            else:
                schema["additionalProperties"] = original_additional_properties_val
    return False
