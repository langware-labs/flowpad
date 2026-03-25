import hashlib


def file_hash(file_path: str) -> str:
    """Calculate the SHA-256 hash of the file at the given path."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def hash_password(salt: str, password: str):
    """Hash a password with a salt."""
    # Concatenate the salt and password
    salted_password = salt + password
    # Hash the salted password
    hashed_password = hashlib.sha256(salted_password.encode()).hexdigest()
    return hashed_password
