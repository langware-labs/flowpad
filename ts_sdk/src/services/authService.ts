import config from '../config';
import { Func } from '../entities/plugin';
import { QueryRequest } from '../FlowSync';

class AuthService {
  private authComponents: { [key: string]: string[] } = {};

  async init() {
    const request = new QueryRequest({
      type: 'func',
      query: { capability: 'auth-component' },
      name: 'authService init auth-component query',
    });
    const funcs = await Func.query(request);

    for (const func of funcs) {
      await this.loadAuthComponent(func);
    }
  }

  async loadAuthComponent(func: Func) {
    if (
      func &&
      func.capability === 'auth-component' &&
      func.capability_config?.importPath &&
      func.capability_config?.webComponentName &&
      func.capability_config?.authForType
    ) {
      const { webComponentName, importPath, authForType } = func.capability_config;
      if (!this.authComponentsForType(authForType)?.includes(webComponentName)) {
        let fullImportPath = importPath;
        if (!importPath.startsWith('http')) {
          fullImportPath = `${window.location.origin}${config.SUBPATH}/${importPath}`;
        }
        void import(/* @vite-ignore */ fullImportPath);

        this.registerAuthComponentForType(authForType, webComponentName);
      }
    }
  }

  authComponentsForType(type: string) {
    return this.authComponents[type];
  }

  registerAuthComponentForType(type: string, componentName: any) {
    console.log('registering auth component', type, componentName);
    if (!this.authComponents[type]) this.authComponents[type] = [];

    this.authComponents[type].push(componentName);
  }
}

export const authService = new AuthService();

export default authService;
