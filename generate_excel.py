import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

def build_excel_workbook(file_path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    font_family = "Segoe UI"
    c_navy_header = "0F172A"
    c_blue_sub = "1E3A8A"
    c_accent_blue = "2563EB"
    c_emerald_header = "065F46"
    c_gray_stripe = "F8FAFC"
    
    header_fill = PatternFill(start_color=c_navy_header, end_color=c_navy_header, fill_type="solid")
    sub_fill = PatternFill(start_color=c_blue_sub, end_color=c_blue_sub, fill_type="solid")
    stripe_fill = PatternFill(start_color=c_gray_stripe, end_color=c_gray_stripe, fill_type="solid")
    highlight_fill = PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid")
    accent_blue_fill = PatternFill(start_color="DBEAFE", end_color="DBEAFE", fill_type="solid")

    font_title = Font(name=font_family, size=13, bold=True, color="FFFFFF")
    font_header = Font(name=font_family, size=10, bold=True, color="FFFFFF")
    font_bold = Font(name=font_family, size=9.5, bold=True, color="0F172A")
    font_regular = Font(name=font_family, size=9.5, color="1E293B")
    font_emerald_bold = Font(name=font_family, size=9.5, bold=True, color="047857")
    font_note = Font(name=font_family, size=8.5, italic=True, color="64748B")

    thin_border_side = Side(border_style="thin", color="CBD5E1")
    cell_border = Border(left=thin_border_side, right=thin_border_side, top=thin_border_side, bottom=thin_border_side)
    thick_bottom = Border(bottom=Side(border_style="medium", color="0F172A"), left=thin_border_side, right=thin_border_side, top=thin_border_side)

    # ==========================================
    # SHEET 1: Pricing Tiers (باقات الأسعار)
    # ==========================================
    ws1 = wb.create_sheet(title="Pricing Tiers (باقات الأسعار)")
    ws1.views.sheetView[0].showGridLines = True

    ws1.merge_cells("A1:F1")
    title_cell = ws1["A1"]
    title_cell.value = "THE 4 COMMERCIAL TIERS (500, 2000, 4000, 10000) — باقات الأسعار المعتمدة للثانوية العامة"
    title_cell.font = font_title
    title_cell.fill = header_fill
    title_cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws1.row_dimensions[1].height = 38

    headers_ws1 = [
        ("Feature / Metric (البند والمواصفات)", 38),
        ("Tier 1: 500 Students", 20),
        ("Tier 2: 2,000 Students", 20),
        ("Tier 3: 4,000 Students", 20),
        ("Tier 4: 10,000 Students", 22),
        ("Audit & Billing Rules (قواعد الفوترة)", 32)
    ]

    for col_idx, (h_text, width) in enumerate(headers_ws1, 1):
        cell = ws1.cell(row=3, column=col_idx, value=h_text)
        cell.font = font_header
        cell.fill = sub_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = cell_border
        col_letter = get_column_letter(col_idx)
        ws1.column_dimensions[col_letter].width = width
    ws1.row_dimensions[3].height = 30

    rows_data_ws1 = [
        ("Max Active Students Limit (الحد الأقصى للطلاب النشطين)", 500, 2000, 4000, 10000, "Active = bought code/course OR viewed video/took exam"),
        ("Grace Buffer Cap (سعة السماحية المجانية +10%)", 550, 2200, 4400, 11000, "10% overflow allowed for 1 month without forced upgrade"),
        ("One-Time Setup Fee (رسوم التجهيز والتدشين - مرة واحدة)", 12000, 20000, 30000, 45000, "Covers custom domain, Bunny library, branding & assistant training"),
        ("Monthly Retainer - 10 Months (الاشتراك الشهري في الموسم)", 10000, 34000, 62000, 138000, "Paid in advance on the 1st of each month (Aug - May/June)"),
        ("Summer Hiatus Fee - 2 Months (اشتراك فترة الصيف - شهران)", 3500, 7500, 12000, 25000, "Preserves video libraries & database with zero loss"),
        ("Est. Monthly Infra Cost (تكلفة السيرفرات والخدمات)", 1850, 9600, 17625, 38900, "Bunny CDN + Gemini AI Grader + Railway/Supabase compute"),
        ("Net Monthly Developer Profit (صافي الربح الشهري للمطور)", "=B7-B9", "=C7-C9", "=D7-D9", "=E7-E9", "Net cash flow generated every month per teacher"),
        ("Net Profit Margin % (نسبة هامش الربح الصافي)", "=B10/B7", "=C10/C7", "=D10/D7", "=E10/E7", "Consistently between 71.6% and 81.5% net margin"),
        ("Infra Cost per Student (تكلفة الطالب الفعلية على السيرفر)", "=B9/B4", "=C9/C4", "=D9/D4", "=E9/E4", "Real cost across video, AI, and database per student"),
        ("Developer Earning per Student (نصيب الطالب من اشتراك المدرس)", "=B7/B4", "=C7/C4", "=D7/D4", "=E7/E4", "Effective monthly fee collected per student seat"),
        ("Annual Net Profit per Teacher (صافي الربح السنوي من المعلم)", "=(B10*10)+B6", "=(C10*10)+C6", "=(D10*10)+D6", "=(E10*10)+E6", "10 in-season months + initial setup fee"),
        ("Included Monthly Video Bandwidth (باندويث الفيديوهات المتاح)", "5.5 TB", "22.0 TB", "44.0 TB", "110.0 TB", "Calculated on 10 lectures/mo (2h each @ 720p) per student"),
        ("AI Essay Grading Quota (امتحانات المقالي بالذكاء الاصطناعي)", "110,000 Questions", "440,000 Questions", "880,000 Questions", "2,200,000 Questions", "10 exams * 22 essay questions per student bundled 100%"),
        ("SLA Support & Readiness (مستوى الدعم الفني وسرعة الاستجابة)", "2h WhatsApp + 24/7 Exams", "2h WhatsApp + 24/7 Exams", "Instant WhatsApp + 24/7 Exams", "Dedicated VIP Manager + 24/7 Exams", "24/7 emergency readiness during ministerial exam weeks")
    ]

    for row_idx, r_data in enumerate(rows_data_ws1, 4):
        ws1.row_dimensions[row_idx].height = 23
        for col_idx, val in enumerate(r_data, 1):
            cell = ws1.cell(row=row_idx, column=col_idx, value=val)
            cell.border = cell_border
            if col_idx == 1:
                cell.font = font_bold
                cell.alignment = Alignment(horizontal="left", vertical="center")
            elif col_idx == 6:
                cell.font = font_note
                cell.alignment = Alignment(horizontal="left", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="center", vertical="center")
                if isinstance(val, (int, float)) or (isinstance(val, str) and val.startswith("=")):
                    if row_idx in [6, 7, 8, 9, 10, 12, 14]:
                        cell.number_format = '#,##0 "EGP"'
                    elif row_idx == 11:
                        cell.number_format = '0.0%'
                    elif row_idx in [4, 5]:
                        cell.number_format = '#,##0'

            if row_idx == 10: # Net profit
                cell.fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
                cell.font = font_emerald_bold
            elif row_idx == 14: # Annual Net
                cell.fill = highlight_fill
                cell.font = font_bold
            elif row_idx % 2 == 0:
                cell.fill = stripe_fill

    # ==========================================
    # SHEET 2: Server & AI Costs Breakdown
    # ==========================================
    ws2 = wb.create_sheet(title="Server Costs (تكلفة السيرفر)")
    ws2.views.sheetView[0].showGridLines = True

    ws2.merge_cells("A1:G1")
    t2 = ws2["A1"]
    t2.value = "INFRASTRUCTURE, VIDEO CDN & AI GRADER COST MATRIX (500 TO 10,000 STUDENTS)"
    t2.font = font_title
    t2.fill = header_fill
    t2.alignment = Alignment(horizontal="center", vertical="center")
    ws2.row_dimensions[1].height = 38

    headers_ws2 = [
        ("Service Component (بند الخدمة والمزود)", 32),
        ("Technical Workload / Assumptions (معايير الاستهلاك)", 32),
        ("500 Students Cost", 18),
        ("2,000 Students Cost", 18),
        ("4,000 Students Cost", 18),
        ("10,000 Students Cost", 20),
        ("Cost Basis & Calculation Logic", 30)
    ]

    for col_idx, (h_text, width) in enumerate(headers_ws2, 1):
        cell = ws2.cell(row=3, column=col_idx, value=h_text)
        cell.font = font_header
        cell.fill = sub_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = cell_border
        col_letter = get_column_letter(col_idx)
        ws2.column_dimensions[col_letter].width = width
    ws2.row_dimensions[3].height = 30

    infra_rows = [
        ("Application Backend (Node/Express)", "Railway Hobby ($5) / Railway Pro & Hetzner", 250, 2000, 3500, 7500, "Handles API requests, auth & BullMQ queue"),
        ("Frontend Web App (Next.js)", "Vercel / Netlify Free tier -> Pro team", 0, 0, 1000, 2000, "Cached edge rendering of student portal"),
        ("PostgreSQL Database", "Supabase Free tier -> Supabase Pro Compute", 0, 1250, 1500, 3000, "Connection pooling with PgBouncer"),
        ("Bunny Stream Video CDN Bandwidth", "10 videos * 2h @ 720p = 10.8 GB/student ($0.005/GB)", 1350, 5400, 9700, 21600, "Bunny edge bandwidth in Egypt/Middle East"),
        ("Bunny Stream Video Catalog Storage", "Encoded video catalog preservation ($0.01/GB)", 15, 50, 125, 300, "Storage for all uploaded recordings"),
        ("Gemini 2.5 Flash AI Essay Grader", "10 exams * 22 questions = 220 essay questions/mo", 225, 900, 1800, 4500, "Gemini Flash input $0.075/M, output $0.30/M"),
        ("Cloudflare DNS, SSL & Incidentals", "Cloudflare DDoS protection & custom domain", 10, 0, 0, 0, "DDoS proxy and SSL certificates")
    ]

    for idx, r_data in enumerate(infra_rows, 4):
        ws2.row_dimensions[idx].height = 23
        for col_idx, val in enumerate(r_data, 1):
            cell = ws2.cell(row=idx, column=col_idx, value=val)
            cell.border = cell_border
            if col_idx in [1, 2, 7]:
                cell.font = font_bold if col_idx == 1 else font_regular
                cell.alignment = Alignment(horizontal="left", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.number_format = '#,##0 "EGP"'
            if idx % 2 == 0:
                cell.fill = stripe_fill

    # Total Row
    total_idx = 11
    ws2.row_dimensions[total_idx].height = 26
    ws2.cell(row=total_idx, column=1, value="TOTAL ESTIMATED MONTHLY INFRA (الإجمالي)").alignment = Alignment(horizontal="left", vertical="center")
    ws2.cell(row=total_idx, column=2, value="All cloud & service provider costs").alignment = Alignment(horizontal="left", vertical="center")
    ws2.cell(row=total_idx, column=3, value="=SUM(C4:C10)").number_format = '#,##0 "EGP"'
    ws2.cell(row=total_idx, column=4, value="=SUM(D4:D10)").number_format = '#,##0 "EGP"'
    ws2.cell(row=total_idx, column=5, value="=SUM(E4:E10)").number_format = '#,##0 "EGP"'
    ws2.cell(row=total_idx, column=6, value="=SUM(F4:F10)").number_format = '#,##0 "EGP"'
    ws2.cell(row=total_idx, column=7, value="Targeting under 30% of retainer").alignment = Alignment(horizontal="left", vertical="center")

    for col_idx in range(1, 8):
        c = ws2.cell(row=total_idx, column=col_idx)
        c.font = font_bold
        c.border = thick_bottom
        c.fill = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")

    # ==========================================
    # SHEET 3: Teacher ROI Simulation
    # ==========================================
    ws3 = wb.create_sheet(title="Teacher ROI (جدوى المعلم)")
    ws3.views.sheetView[0].showGridLines = True

    ws3.merge_cells("A1:G1")
    t3 = ws3["A1"]
    t3.value = "TEACHER ROI & COMPETITOR COMPARISON (OUR FLAT FEE VS 15% REVENUE-SHARE)"
    t3.font = font_title
    t3.fill = header_fill
    t3.alignment = Alignment(horizontal="center", vertical="center")
    ws3.row_dimensions[1].height = 38

    ws3["A3"] = "Assumed Average Monthly Student Ticket (متوسط سعر اشتراك الطالب شهرياً):"
    ws3["A3"].font = font_bold
    ws3["D3"] = 250
    ws3["D3"].font = font_bold
    ws3["D3"].number_format = '#,##0 "EGP"'
    ws3["D3"].fill = highlight_fill

    headers_ws3 = [
        ("Active Student Cohort (عدد الطلاب النشطين)", 24),
        ("Teacher Monthly Gross (دخل المعلم الشهري)", 24),
        ("Competitor at 15% Cut (منصات النسبة 15%)", 24),
        ("Our Official Tier Retainer (سعر باقتنا الثابت)", 24),
        ("Teacher Monthly Savings (الوفر الشهري للمعلم)", 26),
        ("Annual Savings - 10 Months (الوفر السنوي)", 24),
        ("Platform Cost as % of Revenue", 22)
    ]

    for col_idx, (h_text, width) in enumerate(headers_ws3, 1):
        cell = ws3.cell(row=5, column=col_idx, value=h_text)
        cell.font = font_header
        cell.fill = sub_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = cell_border
        col_letter = get_column_letter(col_idx)
        ws3.column_dimensions[col_letter].width = width
    ws3.row_dimensions[5].height = 30

    roi_cohorts = [
        (500, 10000),
        (1000, 34000),
        (2000, 34000),
        (3000, 62000),
        (4000, 62000),
        (7500, 138000),
        (10000, 138000)
    ]

    for idx, (count, flat_fee) in enumerate(roi_cohorts, 6):
        ws3.row_dimensions[idx].height = 23
        ws3.cell(row=idx, column=1, value=count).number_format = '#,##0'
        ws3.cell(row=idx, column=2, value=f"=A{idx}*$D$3").number_format = '#,##0 "EGP"'
        ws3.cell(row=idx, column=3, value=f"=B{idx}*0.15").number_format = '#,##0 "EGP"'
        ws3.cell(row=idx, column=4, value=flat_fee).number_format = '#,##0 "EGP"'
        ws3.cell(row=idx, column=5, value=f"=C{idx}-D{idx}").number_format = '#,##0 "EGP"'
        ws3.cell(row=idx, column=6, value=f"=E{idx}*10").number_format = '#,##0 "EGP"'
        ws3.cell(row=idx, column=7, value=f"=D{idx}/B{idx}").number_format = '0.0%'

        for col_idx in range(1, 8):
            c = ws3.cell(row=idx, column=col_idx)
            c.border = cell_border
            c.alignment = Alignment(horizontal="center", vertical="center")
            if col_idx in [5, 6]:
                c.font = font_emerald_bold
                c.fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
            elif col_idx == 7:
                c.font = font_bold
                c.fill = PatternFill(start_color="EFF6FF", end_color="EFF6FF", fill_type="solid")
            else:
                c.font = font_regular if col_idx != 1 else font_bold
                if idx % 2 == 0:
                    c.fill = stripe_fill

    # ==========================================
    # SHEET 4: Custom Features Catalog
    # ==========================================
    ws4 = wb.create_sheet(title="Custom Dev (تطوير الميزات)")
    ws4.views.sheetView[0].showGridLines = True

    ws4.merge_cells("A1:G1")
    t4 = ws4["A1"]
    t4.value = "CUSTOM DEVELOPMENT CATALOG & HOURLY RATES — كتالوج أسعار الميزات الإضافية"
    t4.font = font_title
    t4.fill = header_fill
    t4.alignment = Alignment(horizontal="center", vertical="center")
    ws4.row_dimensions[1].height = 38

    headers_ws4 = [
        ("Feature Module (اسم الميزة / الموديول)", 28),
        ("Category (التصنيف)", 18),
        ("Functional Scope (الوصف والنطاق الوظيفي)", 36),
        ("Est. Dev Hours", 16),
        ("Standalone Price", 20),
        ("Delivery Time", 18),
        ("SLA Inclusion", 22)
    ]

    for col_idx, (h_text, width) in enumerate(headers_ws4, 1):
        cell = ws4.cell(row=3, column=col_idx, value=h_text)
        cell.font = font_header
        cell.fill = sub_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = cell_border
        col_letter = get_column_letter(col_idx)
        ws4.column_dimensions[col_letter].width = width
    ws4.row_dimensions[3].height = 30

    features_data = [
        ("WhatsApp Parent Alerts Bot (بوت واتساب لأولياء الأمور)", "Notifications & CRM", "Auto-sending exam scores & absence alerts to parents via WhatsApp API", 14, 8000, "5 Business Days", "Included in monthly SLA"),
        ("Center Barcode & Offline Attendance (نظام باركود السنتر)", "Offline Center Integration", "QR/Barcode scanner for student physical cards, sync with online progress", 12, 7500, "5 Business Days", "Included in monthly SLA"),
        ("Custom Dedicated Merchant Gateway (باي موب / فوري خاص)", "Payments Integration", "Binding teacher's legal entity Paymob/Fawry account directly", 6, 4000, "3 Business Days", "Included in monthly SLA"),
        ("Marketing Landing Page & Pixel Tracking (صفحة هبوط تسويقية)", "Marketing & Growth", "High-converting Arabic landing page with Meta Pixel & TikTok tracking", 6, 3500, "2 Business Days", "Included in monthly SLA"),
        ("Custom Teacher Assistant Roles (صلاحيات مخصصة للمساعدين)", "Admin Management", "Granular roles: Exam Grader only, Video Manager, Accountant", 8, 4500, "3 Business Days", "Included in monthly SLA"),
        ("Custom Hourly Engineering Rate (أجر ساعة التطوير المخصصة)", "Ad-hoc Development", "Any unique request outside standard catalog (billed in 30-min increments)", 1, 600, "On Demand", "Billed at month-end")
    ]

    for idx, r_data in enumerate(features_data, 4):
        ws4.row_dimensions[idx].height = 23
        for col_idx, val in enumerate(r_data, 1):
            cell = ws4.cell(row=idx, column=col_idx, value=val)
            cell.border = cell_border
            if col_idx in [1, 2, 3, 6, 7]:
                cell.font = font_bold if col_idx == 1 else font_regular
                cell.alignment = Alignment(horizontal="left", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="center", vertical="center")
                if col_idx == 4:
                    cell.number_format = '#,##0 "Hrs"'
                elif col_idx == 5:
                    cell.number_format = '#,##0 "EGP"'
                    cell.font = font_bold
            if idx % 2 == 0:
                cell.fill = stripe_fill

    # ==========================================
    # SHEET 5: Agency 1-Year Financial Forecast
    # ==========================================
    ws5 = wb.create_sheet(title="Agency Forecast (توقعات الدخل)")
    ws5.views.sheetView[0].showGridLines = True

    ws5.merge_cells("A1:G1")
    t5 = ws5["A1"]
    t5.value = "AGENCY 1-YEAR FINANCIAL PROJECTIONS — التوقعات المالية لأرباح فريق العمل السنوية"
    t5.font = font_title
    t5.fill = header_fill
    t5.alignment = Alignment(horizontal="center", vertical="center")
    ws5.row_dimensions[1].height = 38

    headers_ws5 = [
        ("Client Mix Portfolio (محفظة العملاء)", 28),
        ("Total Setup Fees", 22),
        ("10-Month Retainers", 24),
        ("2-Month Summer Fees", 22),
        ("Total Annual Gross", 24),
        ("Total Cloud & AI Costs", 24),
        ("Total Net Annual Profit", 26)
    ]

    for col_idx, (h_text, width) in enumerate(headers_ws5, 1):
        cell = ws5.cell(row=3, column=col_idx, value=h_text)
        cell.font = font_header
        cell.fill = sub_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = cell_border
        col_letter = get_column_letter(col_idx)
        ws5.column_dimensions[col_letter].width = width
    ws5.row_dimensions[3].height = 30

    portfolios = [
        ("Scenario A: 2x 500-Student Teachers", 24000, 200000, 14000, "=B4+C4+D4", 44400, "=E4-F4"),
        ("Scenario B: 3x 500 + 1x 2,000 Teacher", 56000, 640000, 36000, "=B5+C5+D5", 171500, "=E5-F5"),
        ("Scenario C: 3x 2,000 + 1x 4,000 Teacher", 90000, 1640000, 69000, "=B6+C6+D6", 464250, "=E6-F6"),
        ("Scenario D: 5x 2,000 + 2x 4,000 Teacher", 160000, 2940000, 99000, "=B7+C7+D7", 832500, "=E7-F7"),
        ("Scenario E: 1x 10,000 Mega Teacher", 45000, 1380000, 50000, "=B8+C8+D8", 466800, "=E8-F8")
    ]

    for idx, r_data in enumerate(portfolios, 4):
        ws5.row_dimensions[idx].height = 23
        for col_idx, val in enumerate(r_data, 1):
            cell = ws5.cell(row=idx, column=col_idx, value=val)
            cell.border = cell_border
            if col_idx == 1:
                cell.font = font_bold
                cell.alignment = Alignment(horizontal="left", vertical="center")
            else:
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.number_format = '#,##0 "EGP"'
                if col_idx == 7:
                    cell.font = font_emerald_bold
                    cell.fill = PatternFill(start_color="D1FAE5", end_color="D1FAE5", fill_type="solid")
                elif col_idx == 5:
                    cell.font = font_bold
                    cell.fill = highlight_fill
            if idx % 2 == 0:
                cell.fill = stripe_fill

    wb.save(file_path)
    print(f"Successfully generated updated Excel workbook at: {file_path}")

if __name__ == "__main__":
    build_excel_workbook("thanaweya_platform_commercial_model.xlsx")
