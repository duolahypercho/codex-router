import { createContext, useContext } from "react";
import { createTranslator, type Translate } from "./i18n.ts";

// React belongs to the renderer package. Keep the message engine, backend
// adapter and formatters importable with only the root package installed.
export const I18nContext = createContext<Translate>(createTranslator("en"));
export function useI18n(): Translate { return useContext(I18nContext); }
