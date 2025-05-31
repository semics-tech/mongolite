// This file provides global type definitions
// or type extensions that are needed across the project

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
    errno?: number;
    path?: string;
    syscall?: string;
  }
}
