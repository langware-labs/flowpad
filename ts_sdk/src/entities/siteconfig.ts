export interface ISiteConfig {
  domain?: string;
  branding: {
    company_name: string;
    logo_url: string;
    use_brightness_filter: boolean;
  };
  colors: {
    primary_color: string;
  };
  content: {
    badge: string;
    header: string;
    subheader: string;
    placeholder: string;
  };
  feature_flags?: {
    enable_escalation?: boolean;
    require_login?: boolean;
  };
}
