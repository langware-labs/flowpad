import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import ChatInput from '@src/components/chat-input';
import { Footer } from '@src/components/footer';
import { ProjectGrid } from '@src/components/project-grid';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { ContextEntitiesEnum, dataContext } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useEffect } from 'react';
import { useColorPalette } from '../../hooks/useColorPalette';
import { Header } from './header/header';
import './landing-page.css';

export default function LandingPage() {
  const { agent } = useAgentContext();
  const { sendMessage } = useSendMessageStore();
  const { user } = useAuth();
  const siteConfig = agent?.site_config;
  useColorPalette(siteConfig);

  // Clear only flow from dataContext when landing page is displayed
  // Keep project in context so user stays in their current project when navigating back
  useEffect(() => {
    void dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentFlowTypeId, null);
  }, []);

  return (
    <div
      data-testid="landing-page"
      className="relative flex min-h-screen w-full flex-col overflow-hidden bg-background"
    >
      <div className="sticky top-0 z-50 w-full">
        <Header />
      </div>

      <main className="relative z-10 flex min-h-[calc(100vh-185px)] flex-1 flex-col">
        <section className="flex w-full flex-col items-center px-6 py-24 text-center md:py-32">
          <div className="animate-fade-in-up mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-5 py-2 font-medium text-primary shadow-lg backdrop-blur-sm">
            <span>{siteConfig?.content?.badge || 'Solution Engineering Agents'}</span>
          </div>

          <h1 className="animate-fade-in-up animation-delay-200 mb-6 max-w-5xl text-5xl font-extrabold leading-tight tracking-tight md:text-7xl">
            {siteConfig?.content?.header || (
              <>
                <span className="bg-gradient-to-br from-foreground via-foreground/90 to-foreground/70 bg-clip-text text-transparent">
                  Integrations.
                </span>{' '}
                <span className="bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent">
                  Done!
                </span>
              </>
            )}
          </h1>

          <h2 className="animate-fade-in-up animation-delay-400 mb-4 max-w-2xl text-xl font-medium text-foreground/60 md:text-2xl">
            {siteConfig?.content?.subheader || 'Skip the docs. Get working code.'}
          </h2>

          <div className="animate-fade-in-up animation-delay-800 mt-12 w-full md:max-w-[70%] lg:max-w-[50%]">
            <div className="relative">
              <div className="absolute -inset-1 rounded-lg bg-gradient-to-r from-primary/20 via-primary/10 to-primary/20 opacity-50 blur-xl" />
              <div className="relative">
                <ChatInput
                  onSendMessage={(msg, options) => {
                    void sendMessage?.(msg, options);
                  }}
                  siteConfig={siteConfig}
                  isFollowup={false}
                  codebaseConnectionEnabled={true}
                />
              </div>
            </div>
          </div>
        </section>
      </main>

      {user ? <ProjectGrid /> : null}

      <Footer className="w-full" />
    </div>
  );
}
