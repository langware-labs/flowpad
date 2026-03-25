from hashlib import sha256

from pydantic import BaseModel

from flow_sdk.builtin.user import User


class SignupInfo(BaseModel):
    name: str | None = None
    picture: str | None = None
    email: str
    password: str | None


class LoginInfo(BaseModel):
    email: str
    password: str | None
    remember_me: bool = False

    @property
    def hash(self):
        # Create a hash based on email and password (you can also include remember_me if needed)
        return sha256((self.email + self.password).encode("utf-8")).hexdigest() if self.password else None


class TokenInfo(BaseModel):
    token: str
    refresh_token: str | None = None
    expires: float


class LoginData(BaseModel):
    token: str
    refresh_token: str | None = None
    expires: float
    user: User
