import json
import os
import socket
import uuid

import appdirs

from flow_sdk.config import default_service_config
from flow_sdk.core.auth.models import SignupInfo

local_siginin_domain = "local.machine"


class LocalSignin:
    def __init__(self):
        self.machine_name = socket.gethostname()
        self.is_allowed: bool = default_service_config.is_local_user_allowed
        self.settings = {}
        config_dir = appdirs.user_config_dir("temp_flowpad_dir")
        if not os.path.exists(config_dir):
            os.makedirs(config_dir)
        self.settings_file_path = f"{config_dir}/flowpad_local.json"
        self.signup: SignupInfo = self.gen_local_signup_info()

    @property
    def is_local_signin_allowed(self) -> bool:
        return self.is_allowed

    @property
    def local_signin_email(self) -> str:
        return self.signup.email

    def set_is_allowed(self, is_allowed: bool):
        self.is_allowed = is_allowed

    def is_local_user_in_settings(self) -> bool:
        return self.settings.get("local_user") is not None

    def get_settings_file_path(self) -> str:
        return self.settings_file_path

    def is_user_id_ok(self, user_id: str) -> bool:
        return self.settings.get("local_user_id") == user_id if self.settings.get("local_user_id") else False

    def gen_local_signup_info(self) -> SignupInfo:
        email = f"{self.machine_name}@{local_siginin_domain}"
        password = str(uuid.uuid4())
        self.signup = SignupInfo(name="local", email=email, password=password)
        return self.signup

    def get_local_signup_info(self) -> SignupInfo:
        self.settings = {}
        if os.path.isfile(self.settings_file_path):
            with open(self.settings_file_path, "r") as f:
                self.settings = json.loads(f.read())
        if self.settings.get("local_user"):
            self.signup = SignupInfo(**self.settings["local_user"])
            return self.signup
        else:
            return self.gen_local_signup_info()

    def get_local_signup(self) -> SignupInfo:
        return self.signup


local_signin = LocalSignin()
