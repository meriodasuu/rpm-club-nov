"""Apply to an isolated copy of the deployed RPM Rent source, never a dirty checkout."""
import pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
def replace(path,old,new):
    target=root/path
    content=target.read_text(encoding='utf-8')
    if new in content: return
    if content.count(old)!=1: raise RuntimeError('Unexpected source version: '+path)
    target.write_text(content.replace(old,new),encoding='utf-8')
replace('src/lib/data/prisma-store.ts','rentalPrice: record.rentalPrice,','''rentalPrice: record.source === "rpm_club" && /^\\d{1,15}$/.test(asStringRecord(record.utm).rpm_club_total_kopecks ?? "")
        ? Number(asStringRecord(record.utm).rpm_club_total_kopecks) / 100
        : record.rentalPrice,''')
replace('src/lib/format.ts','maximumFractionDigits: 0','maximumFractionDigits: 2')
replace('src/lib/direct-traffic.ts','export const trafficSourceLabel = (source: string) =>','export const trafficSourceLabel = (source: string) => source === "rpm_club" ? "Из RPM Club" :')
replace('src/lib/telegram.ts','`🆕 ${heading}`,','`🆕 ${heading}${booking.source === "rpm_club" ? " · Из RPM Club" : ""}`,')
print('RPM Rent source label and exact Club price applied')
