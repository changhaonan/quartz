import styles from "../widgets/styles.scss"
// @ts-ignore
import script from "../widgets/bootstrap.inline"
import { QuartzComponent, QuartzComponentConstructor } from "./types"

const WidgetHost: QuartzComponent = () => null

WidgetHost.css = styles
WidgetHost.afterDOMLoaded = script

export default (() => WidgetHost) satisfies QuartzComponentConstructor
