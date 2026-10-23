// «Gjenkjenn tekst»: the toolbar chip that asks for OCR on a scanned document
// when the setting reads pages only on request (ocr.ts). Same slot and shape
// as «N vedlegg» and «Signert» — a property of the DOCUMENT, shown only while
// it is true — and the visible way in that the discoverability rule asks
// for; the search bar and the assistant offer the same action.
import { t, useLang } from '../i18n'
import { IconText } from './icons'

export function OcrBadge({ offer, onEnable }: { offer: boolean; onEnable(): void }): React.JSX.Element | null {
  useLang()
  if (!offer) return null
  return (
    <div className="signature-info">
      <button className="tb-btn tb-labeled" onClick={onEnable} title={t('ocr.enableTip')}>
        <IconText size={15} />
        <span>{t('ocr.enable')}</span>
      </button>
    </div>
  )
}
