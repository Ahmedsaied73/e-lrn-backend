import sys
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

def create_deck(file_path):
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]

    # Colors
    c_navy = RGBColor(15, 23, 42)       # #0F172A
    c_blue = RGBColor(37, 99, 235)      # #2563EB
    c_emerald = RGBColor(16, 185, 129)  # #10B981
    c_dark_green = RGBColor(4, 120, 87) # #047857
    c_slate = RGBColor(51, 65, 85)      # #334155
    c_muted = RGBColor(100, 116, 139)   # #64748B
    c_card_bg = RGBColor(248, 250, 252) # #F8FAFC
    c_border = RGBColor(226, 232, 240)  # #E2E8F0
    c_white = RGBColor(255, 255, 255)
    c_amber = RGBColor(217, 119, 6)     # #D97706
    c_soft_blue = RGBColor(239, 246, 255) # #EFF6FF

    def add_header(slide, title_text, category_text="COMMERCIAL STRATEGY & TIERS"):
        cat_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.4), Inches(11.7), Inches(0.4))
        tf_cat = cat_box.text_frame; tf_cat.word_wrap = True
        p_cat = tf_cat.paragraphs[0]
        p_cat.text = category_text.upper()
        p_cat.font.name = "Calibri"; p_cat.font.size = Pt(11); p_cat.font.bold = True; p_cat.font.color.rgb = c_blue

        title_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.7), Inches(11.7), Inches(0.8))
        tf_title = title_box.text_frame; tf_title.word_wrap = True
        p_title = tf_title.paragraphs[0]
        p_title.text = title_text
        p_title.font.name = "Calibri"; p_title.font.size = Pt(23); p_title.font.bold = True; p_title.font.color.rgb = c_navy

    def add_card(slide, left, top, width, height, bg_color=c_card_bg, border_color=c_border):
        shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
        shape.fill.solid()
        shape.fill.fore_color.rgb = bg_color
        if border_color:
            shape.line.color.rgb = border_color
            shape.line.width = Pt(1.5)
        else:
            shape.line.fill.background()
        return shape

    # ==============================================================
    # SLIDE 1: Title Slide (Dark Theme)
    # ==============================================================
    s1 = prs.slides.add_slide(blank_layout)
    bg1 = s1.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(13.333), Inches(7.5))
    bg1.fill.solid(); bg1.fill.fore_color.rgb = c_navy; bg1.line.fill.background()

    tbox = s1.shapes.add_textbox(Inches(1.2), Inches(1.8), Inches(10.9), Inches(3.6))
    tf1 = tbox.text_frame; tf1.word_wrap = True

    p0 = tf1.paragraphs[0]
    p0.text = "THANAWEYA-AMMA PLATFORM COMMERCIAL STRATEGY"
    p0.font.name = "Calibri"; p0.font.size = Pt(13); p0.font.bold = True; p0.font.color.rgb = c_emerald; p0.space_after = Pt(12)

    p1 = tf1.add_paragraph()
    p1.text = "The 4-Tier Commercial Model & Server Cost Engineering"
    p1.font.name = "Calibri"; p1.font.size = Pt(34); p1.font.bold = True; p1.font.color.rgb = c_white; p1.space_after = Pt(14)

    p2 = tf1.add_paragraph()
    p2.text = "Scaling from 500 to 10,000 Active Students with Bunny.net Video & Gemini AI Essay Grading"
    p2.font.name = "Calibri"; p2.font.size = Pt(18); p2.font.color.rgb = RGBColor(203, 213, 225); p2.space_after = Pt(24)

    p3 = tf1.add_paragraph()
    p3.text = "Executive Strategy & Operational Blueprint | October 2026"
    p3.font.name = "Calibri"; p3.font.size = Pt(12); p3.font.color.rgb = c_muted

    # ==============================================================
    # SLIDE 2: Executive Summary & The Core Thesis
    # ==============================================================
    s2 = prs.slides.add_slide(blank_layout)
    add_header(s2, "Executive Summary: Transforming Cloud Workloads into High Margins", "Core Strategy")

    col_w = Inches(3.64); h_cards = Inches(5.0)

    # Card 1: Workload & Real Costs
    add_card(s2, Inches(0.8), Inches(1.7), col_w, h_cards)
    tb = s2.shapes.add_textbox(Inches(1.0), Inches(1.9), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "1. Real Cloud Unit Costs"; p.font.size = Pt(17); p.font.bold = True; p.font.color.rgb = c_blue; p.space_after = Pt(12)
    bullets1 = [
        "Workload Baseline: 10 videos/mo (2h each @ 720p) = ~10.8 GB video bandwidth/student.",
        "Bunny CDN Cost: Only ~$0.054 USD (~2.70 EGP) per student/mo.",
        "AI Essay Grader (Gemini Flash): 10 exams * 22 essay questions (220 questions) = ~$0.009 USD (~0.45 EGP) per student.",
        "Total Real Cost per Student: ~3.70 to 5.00 EGP (far below the 8 EGP conservative ceiling)."
    ]
    for b in bullets1:
        pb = tf.add_paragraph(); pb.text = "• " + b; pb.font.size = Pt(12); pb.font.color.rgb = c_slate; pb.space_after = Pt(8)

    # Card 2: Pricing Logic
    add_card(s2, Inches(4.84), Inches(1.7), col_w, h_cards)
    tb = s2.shapes.add_textbox(Inches(5.04), Inches(1.9), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "2. Fixed Monthly Brackets"; p.font.size = Pt(17); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(12)
    bullets2 = [
        "We package into 4 Clean Brackets: 500, 2,000, 4,000, and 10,000 active students.",
        "Equivalent to charging 13.80 to 20.00 EGP per student seat while incurring ~4.50 EGP cost.",
        "Predictable Monthly Retainers: 10K, 34K, 62K, and 138K EGP/mo.",
        "Grace Buffer (+10%): Teachers get 10% student overflow before upgrading (zero friction)."
    ]
    for b in bullets2:
        pb = tf.add_paragraph(); pb.text = "• " + b; pb.font.size = Pt(12); pb.font.color.rgb = c_slate; pb.space_after = Pt(8)

    # Card 3: Developer Profitability
    add_card(s2, Inches(8.88), Inches(1.7), col_w, h_cards, bg_color=c_soft_blue, border_color=c_emerald)
    tb = s2.shapes.add_textbox(Inches(9.08), Inches(1.9), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "3. Sustained 72-81% Net Margin"; p.font.size = Pt(17); p.font.bold = True; p.font.color.rgb = c_dark_green; p.space_after = Pt(12)
    bullets3 = [
        "Tier 1 (500): 10K Retainer - 1.85K Infra = ~8,150 EGP net profit/mo (81.5% margin).",
        "Tier 2 (2,000): 34K Retainer - 9.6K Infra = ~24,400 EGP net profit/mo (71.7% margin).",
        "Tier 3 (4,000): 62K Retainer - 17.6K Infra = ~44,375 EGP net profit/mo (71.6% margin).",
        "Tier 4 (10,000): 138K Retainer - 38.9K Infra = ~99,100 EGP net profit/mo (71.8% margin)."
    ]
    for b in bullets3:
        pb = tf.add_paragraph(); pb.text = "• " + b; pb.font.size = Pt(12); pb.font.color.rgb = c_slate; pb.space_after = Pt(8)

    # ==============================================================
    # SLIDE 3: The 4 Official Tiers Overview
    # ==============================================================
    s3 = prs.slides.add_slide(blank_layout)
    add_header(s3, "The 4 Commercial Packages (500 to 10,000 Students)", "Package Architecture")

    card_w = Inches(2.7); card_h = Inches(4.8)
    tiers_data = [
        ("TIER 1: STARTER", "Up to 500 Students", "12,000 EGP", "10,000 EGP", "3,500 EGP", "~1,850 EGP", "~8,150 EGP", "81.5%", c_border, c_card_bg),
        ("TIER 2: PRO", "Up to 2,000 Students", "20,000 EGP", "34,000 EGP", "7,500 EGP", "~9,600 EGP", "~24,400 EGP", "71.7%", c_blue, c_soft_blue),
        ("TIER 3: ELITE", "Up to 4,000 Students", "30,000 EGP", "62,000 EGP", "12,000 EGP", "~17,625 EGP", "~44,375 EGP", "71.6%", c_border, c_card_bg),
        ("TIER 4: MEGA STAR", "Up to 10,000 Students", "45,000 EGP", "138,000 EGP", "25,000 EGP", "~38,900 EGP", "~99,100 EGP", "71.8%", c_border, c_card_bg)
    ]

    for idx, (t_name, quota, setup, monthly, summer, infra, profit, margin, b_col, bg_col) in enumerate(tiers_data):
        pos_x = Inches(0.8) + idx * (card_w + Inches(0.3))
        add_card(s3, pos_x, Inches(1.8), card_w, card_h, bg_color=bg_col, border_color=b_col)
        tb = s3.shapes.add_textbox(pos_x + Inches(0.18), Inches(2.0), card_w - Inches(0.36), card_h - Inches(0.4))
        tf = tb.text_frame; tf.word_wrap = True

        p = tf.paragraphs[0]; p.text = t_name; p.font.size = Pt(14); p.font.bold = True; p.font.color.rgb = c_navy if "PRO" not in t_name else c_blue; p.space_after = Pt(2)
        ps = tf.add_paragraph(); ps.text = quota; ps.font.size = Pt(11); ps.font.color.rgb = c_muted; ps.space_after = Pt(10)

        rows = [
            ("Setup Fee", setup),
            ("In-Season Retainer", monthly),
            ("Summer Retainer", summer),
            ("Est. Cloud Infra", infra),
            ("Net Profit / Mo", profit),
            ("Net Margin %", margin)
        ]
        for l, v in rows:
            pm = tf.add_paragraph()
            pm.text = f"{l}: "
            pm.font.size = Pt(11); pm.font.color.rgb = c_slate
            r = pm.add_run(); r.text = v; r.font.bold = True
            if "Profit" in l:
                r.font.color.rgb = c_dark_green; r.font.size = Pt(12)
            elif "In-Season" in l:
                r.font.color.rgb = c_blue; r.font.size = Pt(11.5)
            else:
                r.font.color.rgb = c_navy
            pm.space_after = Pt(4)

    # ==============================================================
    # SLIDE 4: Defining & Auditing the "Active Student"
    # ==============================================================
    s4 = prs.slides.add_slide(blank_layout)
    add_header(s4, "Defining and Auditing the 'Active Student'", "Billing Standards")

    add_card(s4, Inches(0.8), Inches(1.8), Inches(5.6), Inches(4.8))
    tb_l = s4.shapes.add_textbox(Inches(1.1), Inches(2.0), Inches(5.0), Inches(4.4))
    tf_l = tb_l.text_frame; tf_l.word_wrap = True

    p = tf_l.paragraphs[0]; p.text = "The 'Active Student' Standard"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(12)
    crit = [
        ("Course Enrollment", "A student who redeemed or enrolled in any course (paid code or free promotional lecture) in that 30-day billing cycle."),
        ("Video Streaming Activity", "Any student who streamed at least 1 video on Bunny Stream during the month, consuming CDN bandwidth."),
        ("Exam & Quiz Submissions", "Any student who attempted an exam or submitted essay answers for AI evaluation."),
        ("Dormant Accounts Excluded", "Students registered months ago who took zero actions this month are 100% EXCLUDED from tier counts.")
    ]
    for c_title, c_desc in crit:
        pt = tf_l.add_paragraph(); pt.text = f"✓ {c_title}"; pt.font.size = Pt(12.5); pt.font.bold = True; pt.font.color.rgb = c_blue
        pd = tf_l.add_paragraph(); pd.text = c_desc; pd.font.size = Pt(11.5); pd.font.color.rgb = c_slate; pd.space_after = Pt(6)

    add_card(s4, Inches(6.9), Inches(1.8), Inches(5.6), Inches(4.8), bg_color=c_soft_blue, border_color=c_blue)
    tb_r = s4.shapes.add_textbox(Inches(7.2), Inches(2.0), Inches(5.0), Inches(4.4))
    tf_r = tb_r.text_frame; tf_r.word_wrap = True

    p = tf_r.paragraphs[0]; p.text = "Grace Buffer & Upgrade Rules"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_emerald; p.space_after = Pt(12)
    rules = [
        ("+10% Grace Buffer", "Tier 1 (500) allows up to 550 active students with zero penalties. We never embarrass the teacher or block student access unexpectedly."),
        ("Smooth Upgrade Trigger", "A tier upgrade is triggered only if the teacher exceeds the 10% buffer, or remains above the cap for 2 consecutive billing cycles."),
        ("Transparency Dashboard", "The teacher's admin console includes a live 'Active Student Gauge' showing exact active accounts and last login dates."),
        ("Zero Dispute Guarantee", "Because active criteria matches actual cloud resource burn, teachers respect and understand the tier boundary.")
    ]
    for r_title, r_desc in rules:
        pt = tf_r.add_paragraph(); pt.text = f"• {r_title}"; pt.font.size = Pt(12.5); pt.font.bold = True; pt.font.color.rgb = c_navy
        pd = tf_r.add_paragraph(); pd.text = r_desc; pd.font.size = Pt(11.5); pd.font.color.rgb = c_slate; pd.space_after = Pt(6)

    # ==============================================================
    # SLIDE 5: Server & Video Workload Math (Deep Dive)
    # ==============================================================
    s5 = prs.slides.add_slide(blank_layout)
    add_header(s5, "Video CDN & AI Grader Workload Engineering", "Workload Engineering")

    add_card(s5, Inches(0.8), Inches(1.8), Inches(11.7), Inches(4.8))
    tb = s5.shapes.add_textbox(Inches(1.1), Inches(2.0), Inches(11.1), Inches(4.4))
    tf = tb.text_frame; tf.word_wrap = True

    p = tf.paragraphs[0]; p.text = "Mathematical Proof of Cloud Provider Costs"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(8)

    math_blocks = [
        ("1. Video Streaming (Bunny.net Stream Edge)", [
            "Assumption: 10 videos/month, 2 hours per lecture, 720p adaptive resolution (~1.2 Mbps bitrate).",
            "Data Consumption: 2 hours of 720p = ~1.08 GB. 10 lectures = 10.8 GB per student per month.",
            "Bunny Edge Pricing: $0.005/GB standard edge rate ($0.004/GB for volume >= 40TB).",
            "Resulting Cost: 10.8 GB * $0.005 = $0.054 USD = ~2.70 EGP per student per month."
        ]),
        ("2. AI Essay Grading (Google Gemini 2.5 Flash)", [
            "Assumption: 10 exams/month, each exam has 22 essay questions = 220 essay questions graded per student.",
            "Token Consumption: ~300 input tokens (question + rubric + student text) + ~100 output tokens (score JSON) = ~400 tokens/call.",
            "Total Student Tokens: 220 calls * 400 tokens = 88,000 tokens (0.088M tokens) per student per month.",
            "Gemini Pricing: $0.075/1M input, $0.30/1M output -> Total Cost = ~$0.009 USD = ~0.45 EGP per student per month!"
        ]),
        ("3. Web App Compute & Database (Railway / Hetzner / Supabase)", [
            "Tier 1 (500 Students): $5 Railway Hobby backend + $0 Vercel frontend + $0 Supabase DB = $5/mo (~250 EGP).",
            "Tier 2+ (1,500+ Students): Scaled compute + Supabase Pro DB with connection pooling = ~$65/mo (~3,250 EGP)."
        ])
    ]

    for title, lines in math_blocks:
        pt = tf.add_paragraph(); pt.text = title; pt.font.size = Pt(13); pt.font.bold = True; pt.font.color.rgb = c_blue; pt.space_after = Pt(2)
        for l in lines:
            pl = tf.add_paragraph(); pl.text = "   • " + l; pl.font.size = Pt(11); pl.font.color.rgb = c_slate
        pt.space_after = Pt(4)

    # ==============================================================
    # SLIDE 6: Teacher ROI Comparison
    # ==============================================================
    s6 = prs.slides.add_slide(blank_layout)
    add_header(s6, "Teacher ROI: Why Every Teacher Saves 400K+ EGP Annually", "Financial Proof")

    add_card(s6, Inches(0.8), Inches(1.8), Inches(11.7), Inches(4.8))
    tb = s6.shapes.add_textbox(Inches(1.0), Inches(2.0), Inches(11.3), Inches(4.4))
    tf = tb.text_frame; tf.word_wrap = True

    p = tf.paragraphs[0]; p.text = "Financial Comparison: Our Fixed Retainer vs Competitor 15% Cut"; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(4)
    ps = tf.add_paragraph(); ps.text = "Based on standard secondary student monthly ticket of 250 EGP (4-5 lectures + weekly exams):"; ps.font.size = Pt(11.5); ps.font.color.rgb = c_muted; ps.space_after = Pt(12)

    table_data = [
        ("Student Base", "Teacher Gross Revenue", "Competitor 15% Take", "Our Fixed Retainer", "Teacher Monthly Savings", "Cost as % of Income"),
        ("500 Students", "125,000 EGP", "18,750 EGP", "10,000 EGP (T1)", "+8,750 EGP / mo", "8.0%"),
        ("2,000 Students", "500,000 EGP", "75,000 EGP", "34,000 EGP (T2)", "+41,000 EGP / mo", "6.8%"),
        ("4,000 Students", "1,000,000 EGP", "150,000 EGP", "62,000 EGP (T3)", "+88,000 EGP / mo", "6.2%"),
        ("10,000 Students", "2,500,000 EGP", "375,000 EGP", "138,000 EGP (T4)", "+237,000 EGP / mo", "5.5%")
    ]

    for r_idx, row in enumerate(table_data):
        p_row = tf.add_paragraph()
        formatted_row = f"{row[0]:<18} | {row[1]:<24} | {row[2]:<20} | {row[3]:<20} | {row[4]:<24} | {row[5]}"
        p_row.text = formatted_row; p_row.font.name = "Consolas"
        if r_idx == 0:
            p_row.font.size = Pt(11); p_row.font.bold = True; p_row.font.color.rgb = c_blue; p_row.space_after = Pt(6)
        elif r_idx in [2, 3, 4]:
            p_row.font.size = Pt(11.5); p_row.font.bold = True; p_row.font.color.rgb = c_dark_green; p_row.space_after = Pt(4)
        else:
            p_row.font.size = Pt(11); p_row.font.color.rgb = c_slate; p_row.space_after = Pt(4)

    p_bottom = tf.add_paragraph()
    p_bottom.text = "\n💡 Key Takeaway: A 2,000-student teacher saves 410,000 EGP every academic season by switching to our platform!"
    p_bottom.font.size = Pt(13); p_bottom.font.bold = True; p_bottom.font.color.rgb = c_blue

    # ==============================================================
    # SLIDE 7: Seasonality Architecture
    # ==============================================================
    s7 = prs.slides.add_slide(blank_layout)
    add_header(s7, "Seasonality Architecture: 10 Academic Months vs Summer Hiatus", "Seasonality Strategy")

    add_card(s7, Inches(0.8), Inches(1.8), Inches(5.6), Inches(4.8))
    tb_l = s7.shapes.add_textbox(Inches(1.1), Inches(2.0), Inches(5.0), Inches(4.4))
    tf_l = tb_l.text_frame; tf_l.word_wrap = True
    p = tf_l.paragraphs[0]; p.text = "In-Season (August to June) — 10 Months"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_blue; p.space_after = Pt(12)
    pts_l = [
        "Full Operational Retainer: 10K (T1), 34K (T2), 62K (T3), 138K (T4) billed monthly.",
        "Active Support: WhatsApp assistant group active 9 AM - 11 PM with 2h response SLA.",
        "Peak Lecture Release Optimization: Edge CDN routing for massive Friday/Saturday traffic surges.",
        "Ministerial Exam Readiness: 24/7 dedicated engineering standby during final exam weeks in May/June."
    ]
    for pt in pts_l:
        pl = tf_l.add_paragraph(); pl.text = "• " + pt; pl.font.size = Pt(12); pl.font.color.rgb = c_slate; pl.space_after = Pt(8)

    add_card(s7, Inches(6.9), Inches(1.8), Inches(5.6), Inches(4.8), bg_color=c_card_bg, border_color=c_amber)
    tb_r = s7.shapes.add_textbox(Inches(7.2), Inches(2.0), Inches(5.0), Inches(4.4))
    tf_r = tb_r.text_frame; tf_r.word_wrap = True
    p = tf_r.paragraphs[0]; p.text = "Summer Hiatus (July & August) — 2 Months"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_amber; p.space_after = Pt(12)
    pts_r = [
        "Discounted Standby Retainers: 3.5K (T1), 7.5K (T2), 12K (T3), 25K (T4).",
        "100% Churn Prevention: Keeps video libraries, student historical grades, and question banks intact.",
        "Cloud Cost Coverage: Fully finances Bunny video catalog storage and PostgreSQL DB dormancy.",
        "Zero Loss Guarantee: Developer still earns ~3K to 15K net profit monthly during summer."
    ]
    for pt in pts_r:
        pr = tf_r.add_paragraph(); pr.text = "• " + pt; pr.font.size = Pt(12); pr.font.color.rgb = c_slate; pr.space_after = Pt(8)

    # ==============================================================
    # SLIDE 8: Contract Framework & Risk Boundaries
    # ==============================================================
    s8 = prs.slides.add_slide(blank_layout)
    add_header(s8, "Legal Framework & Contractual Architecture", "Legal & Contracts")

    c_w = Inches(3.64)
    contracts = [
        ("Contract 1: Platform License", "White-Label Setup & IP Agreement", [
            "Developer IP Ownership: All platform code, architecture & AI engines remain 100% developer IP.",
            "Exclusive Right of Use: Teacher receives a single non-transferable brand license.",
            "Student Data Sovereignty: Teacher owns 100% of student PII, exam records, and video recordings.",
            "Setup Payment: Setup fee paid 100% upfront before domain launch and assistant training."
        ]),
        ("Contract 2: Hosting & SLA", "Maintenance & Operations SLA", [
            "Uptime Commitment: 99.5% uptime SLA with scheduled off-peak updates.",
            "Support Workflow: Dedicated WhatsApp group with teacher's tech assistants (2h SLA).",
            "Exam Peak Emergency: 24/7 on-call engineering response during ministerial exam weeks.",
            "Automated Disaster Recovery: Daily automated DB snapshots stored in off-site S3 storage."
        ]),
        ("Contract 3: Custom Dev Scope", "Feature Engineering Addendum", [
            "Included Maintenance: Bug fixes, security patches + 4 minor tweak hours/mo included.",
            "Distinct New Modules: Quoted separately via catalog or 600 EGP/engineering hour.",
            "Payment Terms: 50% upfront before development starts, 50% upon deployment acceptance.",
            "Seamless Warranty: All completed custom features roll directly into standard monthly SLA."
        ])
    ]

    for idx, (title, sub, bullets) in enumerate(contracts):
        pos_x = Inches(0.8) + idx * (c_w + Inches(0.38))
        add_card(s8, pos_x, Inches(1.8), c_w, Inches(4.8))
        tb = s8.shapes.add_textbox(pos_x + Inches(0.2), Inches(2.0), c_w - Inches(0.4), Inches(4.4))
        tf = tb.text_frame; tf.word_wrap = True

        p = tf.paragraphs[0]; p.text = title; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(2)
        ps = tf.add_paragraph(); ps.text = sub; ps.font.size = Pt(10.5); ps.font.color.rgb = c_blue; ps.space_after = Pt(10)

        for b in bullets:
            pb = tf.add_paragraph(); pb.text = "• " + b; pb.font.size = Pt(11); pb.font.color.rgb = c_slate; pb.space_after = Pt(6)

    # ==============================================================
    # SLIDE 9: Custom Features Catalog & Expansion Revenue
    # ==============================================================
    s9 = prs.slides.add_slide(blank_layout)
    add_header(s9, "Custom Feature Catalog & Expansion Revenue", "Expansion Revenue")

    add_card(s9, Inches(0.8), Inches(1.8), Inches(11.7), Inches(4.8))
    tb = s9.shapes.add_textbox(Inches(1.1), Inches(2.0), Inches(11.1), Inches(4.4))
    tf = tb.text_frame; tf.word_wrap = True

    p = tf.paragraphs[0]; p.text = "High-Margin Add-On Modules for Thanaweya Teachers"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(12)

    catalog = [
        ("WhatsApp Parent Alerts Bot", "8,000 EGP", "5 Days", "Automated WhatsApp API sending weekly exam scores, homework status & attendance alerts to parents."),
        ("Physical Center Barcode Integration", "7,500 EGP", "5 Days", "QR / Barcode scanner integration for center staff to check student cards and sync offline attendance."),
        ("Custom Dedicated Payment Gateway", "4,000 EGP", "3 Days", "Direct merchant contract setup with Paymob/Fawry under teacher's commercial registry."),
        ("Marketing Landing Page & Pixel Suite", "3,500 EGP", "2 Days", "Conversion-optimized landing page with TikTok/Meta Pixel for summer acquisition campaigns."),
        ("Teacher Assistant Granular Roles", "4,500 EGP", "3 Days", "Separates Exam Graders from Video Uploaders and hides financial reports from assistants."),
        ("Custom Engineering Rate", "600 EGP / hr", "On Demand", "Billed in 30-min increments for any bespoke custom workflows outside catalog.")
    ]

    for name, price, eta, desc in catalog:
        p_item = tf.add_paragraph()
        p_item.text = f"• {name}  |  Price: {price}  |  Delivery: {eta}"
        p_item.font.size = Pt(12.5); p_item.font.bold = True; p_item.font.color.rgb = c_blue
        p_desc = tf.add_paragraph()
        p_desc.text = f"   {desc}"
        p_desc.font.size = Pt(11.5); p_desc.font.color.rgb = c_slate; p_desc.space_after = Pt(6)

    # ==============================================================
    # SLIDE 10: Financial Projections & Portfolio Scenarios
    # ==============================================================
    s10 = prs.slides.add_slide(blank_layout)
    add_header(s10, "Agency Financial Projections: 1-Year Portfolio Scenarios", "Agency Projections")

    add_card(s10, Inches(0.8), Inches(1.8), Inches(11.7), Inches(4.8), bg_color=c_card_bg, border_color=c_blue)
    tb = s10.shapes.add_textbox(Inches(1.1), Inches(2.0), Inches(11.1), Inches(4.4))
    tf = tb.text_frame; tf.word_wrap = True

    p = tf.paragraphs[0]; p.text = "Simulating Agency Revenue & Net Profit across Client Mixes"; p.font.size = Pt(15); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(4)
    ps = tf.add_paragraph(); ps.text = "Combines 10 in-season months + 2 summer months + one-time setup fees minus cloud costs:"; ps.font.size = Pt(11.5); ps.font.color.rgb = c_muted; ps.space_after = Pt(12)

    scenarios = [
        ("Client Mix Portfolio", "Total Setup", "10-Mo Retainers", "Summer Fees", "Annual Gross", "Total Cloud Costs", "Net Annual Profit"),
        ("Scenario A: 2x 500-Student Teachers", "24,000 EGP", "200,000 EGP", "14,000 EGP", "238,000 EGP", "44,400 EGP", "193,600 EGP"),
        ("Scenario B: 3x 500 + 1x 2,000 Teacher", "56,000 EGP", "640,000 EGP", "36,000 EGP", "732,000 EGP", "171,500 EGP", "560,500 EGP"),
        ("Scenario C: 3x 2,000 + 1x 4,000 Teacher", "90,000 EGP", "1,640,000 EGP", "69,000 EGP", "1,799,000 EGP", "464,250 EGP", "1,334,750 EGP"),
        ("Scenario D: 5x 2,000 + 2x 4,000 Teacher", "160,000 EGP", "2,940,000 EGP", "99,000 EGP", "3,199,000 EGP", "832,500 EGP", "2,366,500 EGP"),
        ("Scenario E: 1x 10,000 Mega Teacher", "45,000 EGP", "1,380,000 EGP", "50,000 EGP", "1,475,000 EGP", "466,800 EGP", "1,008,200 EGP")
    ]

    for s_idx, row in enumerate(scenarios):
        p_row = tf.add_paragraph()
        formatted_s = f"{row[0]:<34} | {row[1]:<14} | {row[2]:<16} | {row[3]:<14} | {row[4]:<16} | {row[5]:<16} | {row[6]}"
        p_row.text = formatted_s; p_row.font.name = "Consolas"
        if s_idx == 0:
            p_row.font.size = Pt(10); p_row.font.bold = True; p_row.font.color.rgb = c_blue; p_row.space_after = Pt(6)
        elif s_idx >= 3:
            p_row.font.size = Pt(10.5); p_row.font.bold = True; p_row.font.color.rgb = c_dark_green; p_row.space_after = Pt(4)
        else:
            p_row.font.size = Pt(10); p_row.font.color.rgb = c_slate; p_row.space_after = Pt(4)

    p_callout = tf.add_paragraph()
    p_callout.text = "\n🎯 Scaling Milestone: Signing just 4 established teachers (Scenario B/C) generates over 560K to 1.33M EGP net profit annually!"
    p_callout.font.size = Pt(12.5); p_callout.font.bold = True; p_callout.font.color.rgb = c_blue

    # ==============================================================
    # SLIDE 11: Team Action Plan & Go-To-Market
    # ==============================================================
    s11 = prs.slides.add_slide(blank_layout)
    add_header(s11, "Team Action Plan & Go-To-Market Execution", "Go-To-Market")

    col_w = Inches(3.64); h_cards = Inches(5.0)

    # Step 1
    add_card(s11, Inches(0.8), Inches(1.8), col_w, h_cards)
    tb = s11.shapes.add_textbox(Inches(1.0), Inches(2.0), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "1. Technical Readiness"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_blue; p.space_after = Pt(12)
    s1 = [
        "Deploy single-tenant staging demo with pre-loaded 720p Bunny test streams and 22-question AI essay exam.",
        "Set up Railway Hobby instance ($5) for staging and verify Gemini Flash worker throughput.",
        "Verify dynamic phone number watermark overlay on Bunny Stream player.",
        "Create automated tenant bootstrap script (Bunny library + DB setup)."
    ]
    for s in s1:
        ps = tf.add_paragraph(); ps.text = "• " + s; ps.font.size = Pt(11.5); ps.font.color.rgb = c_slate; ps.space_after = Pt(8)

    # Step 2
    add_card(s11, Inches(4.84), Inches(1.8), col_w, h_cards)
    tb = s11.shapes.add_textbox(Inches(5.04), Inches(2.0), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "2. Sales Enablement"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_navy; p.space_after = Pt(12)
    s2 = [
        "Print out the Arabic White-Label License, SLA, and Custom Dev Addendum templates.",
        "Build a 1-page PDF Savings Calculator contrasting our flat retainer vs 15% revenue share.",
        "Record a 2-minute video showing the teacher assistant grading dashboard and AI exam feedback.",
        "List top 10 target teachers in Physics, Chemistry, Biology, Math, and Arabic."
    ]
    for s in s2:
        ps = tf.add_paragraph(); ps.text = "• " + s; ps.font.size = Pt(11.5); ps.font.color.rgb = c_slate; ps.space_after = Pt(8)

    # Step 3
    add_card(s11, Inches(8.88), Inches(1.8), col_w, h_cards, bg_color=c_soft_blue, border_color=c_emerald)
    tb = s11.shapes.add_textbox(Inches(9.08), Inches(2.0), col_w - Inches(0.4), h_cards - Inches(0.4))
    tf = tb.text_frame; tf.word_wrap = True
    p = tf.paragraphs[0]; p.text = "3. Outreach & Onboarding"; p.font.size = Pt(16); p.font.bold = True; p.font.color.rgb = c_emerald; p.space_after = Pt(12)
    s3 = [
        "Reach out directly to Head Assistants (رئيس المساعدين) who run center operations.",
        "Offer a 14-day zero-risk trial running a single revision exam on the platform.",
        "Sign 6-month contract commitment + collect setup fee upfront.",
        "Conduct 2-hour onboarding workshop with assistant team and launch custom domain."
    ]
    for s in s3:
        ps = tf.add_paragraph(); ps.text = "✓ " + s; ps.font.size = Pt(11.5); ps.font.color.rgb = c_slate; ps.space_after = Pt(8)

    prs.save(file_path)
    print(f"Successfully generated updated PowerPoint presentation at: {file_path}")

if __name__ == "__main__":
    create_deck("thanaweya_platform_commercial_pitch.pptx")
