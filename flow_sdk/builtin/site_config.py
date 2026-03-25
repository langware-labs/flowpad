import logging
"""Site configuration module for FlowPad agents."""

from pydantic import BaseModel, Field


class BrandingConfig(BaseModel):
    company_name: str = Field(default="")
    logo_url: str = Field(default="")
    use_brightness_filter: bool = Field(default=False)


class ColorsConfig(BaseModel):
    primary_color: str = Field(default="")


class ContentConfig(BaseModel):
    badge: str = Field(default="")
    header: str = Field(default="")
    subheader: str = Field(default="")
    placeholder: str = Field(default="")


class FeatureFlagsConfig(BaseModel):
    enable_escalation: bool = Field(default=False)
    require_login: bool = Field(default=False)


class SiteConfig(BaseModel):
    domain: str | None = Field(default=None)
    branding: BrandingConfig = Field(default_factory=BrandingConfig)
    colors: ColorsConfig = Field(default_factory=ColorsConfig)
    content: ContentConfig = Field(default_factory=ContentConfig)
    feature_flags: FeatureFlagsConfig = Field(default_factory=FeatureFlagsConfig)
