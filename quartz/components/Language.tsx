// @ts-ignore
import languageScript from "./scripts/language.inline"
import styles from "./styles/language.scss"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

// Global language toggle for the page chrome. Switches the client-side display
// language (stored in localStorage, broadcast via the `langchange` event) that
// widgets such as the dashboard read. Quartz's own SSR'd UI is unaffected — it
// stays at the build-time cfg.locale.
const Language: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <button class={classNames(displayClass, "langtoggle")} aria-label="Language / 语言">
      <span class="lang-zh">中</span>
      <span class="lang-en">EN</span>
    </button>
  )
}

Language.beforeDOMLoaded = languageScript
Language.css = styles

export default (() => Language) satisfies QuartzComponentConstructor
