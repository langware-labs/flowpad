import json
import logging
import os

from flow_sdk.request_context.methods import get_current_service_config
from flow_sdk.external_apis.llm.utils import generate_hash, sanitize_filename
from flow_sdk.utils import ROOT_FOLDER

FILENAME_DESCRIPTION_WORD_COUNT = 3

CACHE_FOLDER = os.path.join(ROOT_FOLDER, "cached_responses")


def get_cached_response(prompt_string):
    current_config = get_current_service_config()
    if not current_config.llm_cache_enabled:
        return None

    os.makedirs(CACHE_FOLDER, exist_ok=True)
    prompt_hash = generate_hash(prompt_string)
    try:
        for filename in os.listdir(CACHE_FOLDER):
            if filename.endswith(".json") and prompt_hash in filename:
                with open(os.path.join(CACHE_FOLDER, filename), "r") as file:
                    return json.load(file)
    except Exception as e:
        logging.error(f"Error reading from cache: {e}")

    return None


def save_response_to_cache(prompt_string, response):
    current_config = get_current_service_config()
    if not current_config.llm_cache_enabled:
        return

    prompt_hash = generate_hash(prompt_string)
    description = "_".join(prompt_string.split()[:FILENAME_DESCRIPTION_WORD_COUNT])
    sanitized_description = sanitize_filename(description)
    filename = f"{sanitized_description}_{prompt_hash}.json"

    os.makedirs(CACHE_FOLDER, exist_ok=True)
    try:
        with open(os.path.join(CACHE_FOLDER, filename), "w") as file:
            json.dump(response, file, indent=current_config.python_indent_level)  # type: ignore[arg-type]
    except Exception as e:
        logging.error(f"Error saving to cache: {e}")
