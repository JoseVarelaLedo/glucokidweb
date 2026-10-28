import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { AuthService } from './core/auth.service';

const adminOnly = () => {
  const auth = inject(AuthService);
  return auth.isAdmin() ? true : inject(Router).parseUrl('/registro');
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'registro' },
  { path: 'registro', title: 'Registro · GlucoKid', loadComponent: () => import('./pages/registro/registro').then((m) => m.Registro) },
  { path: 'calculadora', title: 'Calculadora · GlucoKid', loadComponent: () => import('./pages/calculadora/calculadora').then((m) => m.Calculadora) },
  { path: 'alimentos', title: 'Alimentos · GlucoKid', loadComponent: () => import('./pages/alimentos/alimentos').then((m) => m.Alimentos) },
  { path: 'docs', title: 'Documentación · GlucoKid', loadComponent: () => import('./pages/docs/docs-list').then((m) => m.DocsList) },
  { path: 'docs/:slug', title: 'Documento · GlucoKid', loadComponent: () => import('./pages/docs/doc-view').then((m) => m.DocView) },
  { path: 'ajustes', title: 'Ajustes · GlucoKid', loadComponent: () => import('./pages/ajustes/ajustes').then((m) => m.Ajustes) },
  { path: 'usuarios', title: 'Usuarios · GlucoKid', canActivate: [adminOnly], loadComponent: () => import('./pages/usuarios/usuarios').then((m) => m.Usuarios) },
  // Pantalla pública de alta por invitación: la dibuja el propio shell (ver app.ts / app.html)
  { path: 'unirse/:code', children: [] },
  { path: '**', redirectTo: 'registro' },
];
