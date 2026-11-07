'use strict';

/**
 * golden-cases.js — 14 Golden Test Cases for AI Grader Rich Math & Chemistry Input.
 *
 * Implements Section 6.1 from MATH_INPUT_IMPLEMENTATION_PLAN.md.
 */

const GOLDEN_CASES = [
  {
    id: 1,
    name: 'equivalent_notation_fraction_vs_decimal',
    description: 'Final answer 0.5 vs reference \\frac{1}{2} -> full',
    question: 'أوجد قيمة س في المعادلة: 2س = 1',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'حل المعادلة:' },
        { t: 'math', v: '2x = 1 \\implies x = \\frac{1}{2}' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'قيمة س هي:' },
        { t: 'math', v: 'x = 0.5' },
      ],
    }),
    rubric: 'الحل الصحيح النهائي نصف أو 0.5 = 10 درجات.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'إجابة صحيحة وكاملة. القيمة 0.5 تكافئ رياضياً 1/2.',
      reasoning: '0.5 and 1/2 are mathematically equivalent',
    },
  },
  {
    id: 2,
    name: 'arabic_variables_seen_vs_x',
    description: 'Same solution with variables س, ص instead of x, y -> full',
    question: 'حل المعادلة التالية تحليلياً موضحاً الخطوات: x^2 - 4 = 0',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'حل المعادلة:' },
        { t: 'math', v: 'x^2 - 4 = 0 \\implies (x - 2)(x + 2) = 0 \\implies x = 2 \\text{ or } x = -2' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'تحليل المعادلة باستخدام المتغير س:' },
        { t: 'math', v: 'س^2 - 4 = 0 \\implies (س - 2)(س + 2) = 0 \\implies س = 2 \\text{ أو } س = -2' },
      ],
    }),
    rubric: 'خطوات التحليل = 5 درجات، إيجاد الحلين 2 و -2 = 5 درجات. استخدام الحروف العربية س وص بدلاً من x و y هو تغيير تسمية مقبول تماماً.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'إجابة ممتازة وخطوات تحليل كاملة وصحيحة باستخدام الرمز س.',
      reasoning: 'Arabic variable seen is equivalent to x',
    },
  },
  {
    id: 3,
    name: 'sign_error_final_answer',
    description: 'Sign error in the final answer -> partial',
    question: 'أوجد المشتقة الأولى للدالة: f(x) = \\cos(2x)',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'مشتقة الدالة:' },
        { t: 'math', v: 'f\'(x) = -2\\sin(2x)' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'مشتقة الدالة هي:' },
        { t: 'math', v: 'f\'(x) = 2\\sin(2x)' },
      ],
    }),
    rubric: 'مشتقة جيب التمام هي سالب جيب، ومشتقة الزاوية 2. الناتج الصحيح -2sin(2x). نسيان إشارة السالب يخصم 4 درجات.',
    maxPoints: 10,
    expectedBand: 'partial',
    minScore: 4,
    maxScore: 7,
    minConfidence: 0.5,
    mockVerdict: {
      score: 6,
      maxScore: 10,
      confidence: 0.85,
      feedback: 'اشتقاق الزاوية صحيح ولكن يوجد خطأ في إشارة المشتقة؛ مشتقة جيب التمام سالبة وليست موجبة.',
      reasoning: 'Sign error in derivative',
    },
  },
  {
    id: 4,
    name: 'missing_steps_with_correct_answer',
    description: 'Correct final answer, steps missing while the rubric requires steps -> partial',
    question: 'احسب النهاية التالية مع توضيح خطوات التحليل والاختصار: \\lim_{x \\to 2} \\frac{x^2 - 4}{x - 2}',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'خطوات الحل:' },
        { t: 'math', v: '\\lim_{x \\to 2} \\frac{(x-2)(x+2)}{x-2} = \\lim_{x \\to 2} (x+2) = 2 + 2 = 4' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'الناتج النهائي:' },
        { t: 'math', v: '4' },
      ],
    }),
    rubric: 'خطوات التحليل والاختصار = 6 درجات، الناتج النهائي 4 = 4 درجات. لا تمنح درجات الخطوات إذا غابت.',
    maxPoints: 10,
    expectedBand: 'partial',
    minScore: 3,
    maxScore: 5,
    minConfidence: 0.5,
    mockVerdict: {
      score: 4,
      maxScore: 10,
      confidence: 0.9,
      feedback: 'الناتج النهائي 4 صحيح ولكن تم خصم درجات خطوات الحل والتحليل لعدم ذكرها كما يطلب المعيار.',
      reasoning: 'Steps missing while rubric explicitly requires them',
    },
  },
  {
    id: 5,
    name: 'missing_units_required_by_rubric',
    description: 'Correct answer, unit missing while the rubric requires it -> deducted',
    question: 'احسب سرعة جسم قطع مسافة 100 متر في زمن قدره 5 ثوانٍ مع كتابة وحدة القياس.',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'السرعة = المسافة / الزمن:' },
        { t: 'math', v: 'v = \\frac{100}{5} = 20\\text{ m/s}' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'السرعة هي:' },
        { t: 'math', v: 'v = \\frac{100}{5} = 20' },
      ],
    }),
    rubric: 'القانون والتعويض والناتج العددي 20 = 8 درجات، كتابة وحدة القياس الصحيحة (m/s أو م/ث) = درجتان.',
    maxPoints: 10,
    expectedBand: 'deducted',
    minScore: 7,
    maxScore: 8.5,
    minConfidence: 0.6,
    mockVerdict: {
      score: 8,
      maxScore: 10,
      confidence: 0.9,
      feedback: 'الحسابات صحيحة تماماً لكن تم خصم درجتين لعدم كتابة وحدة القياس (m/s) المطلوبة في السؤال.',
      reasoning: 'Missing units required by rubric',
    },
  },
  {
    id: 6,
    name: 'wrong_formula_correct_arithmetic',
    description: 'Wrong formula with correct arithmetic -> low',
    question: 'احسب مساحة دائرة نصف قطرها r = 3',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'مساحة الدائرة:' },
        { t: 'math', v: 'A = \\pi r^2 = \\pi (3)^2 = 9\\pi' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'مساحة الدائرة:' },
        { t: 'math', v: 'A = 2\\pi r = 2\\pi (3) = 6\\pi' },
      ],
    }),
    rubric: 'القانون الصحيح A = \\pi r^2 والتعويض = 10 درجات. استخدام قانون المحيط 2\\pi r يعبر عن فهم خاطئ للقانون ويمنح درجات منخفضة (أقل من 3 درجات).',
    maxPoints: 10,
    expectedBand: 'low',
    minScore: 0,
    maxScore: 3,
    minConfidence: 0.6,
    mockVerdict: {
      score: 2,
      maxScore: 10,
      confidence: 0.9,
      feedback: 'تم استخدام قانون محيط الدائرة (2πr) بدلاً من قانون مساحة الدائرة (πr²). الحساب العددي صحيح لكن القانون خاطئ.',
      reasoning: 'Wrong formula applied',
    },
  },
  {
    id: 7,
    name: 'malformed_equation_block',
    description: 'Malformed equation block (\\frac{1}{) -> feedback mentions it is unreadable, no marks for that part',
    question: 'أوجد ميل المماس لمنحنى الدالة y = \\frac{1}{x} عند x = 2',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'المشتقة:' },
        { t: 'math', v: 'y\' = -\\frac{1}{x^2} \\implies y\'(2) = -\\frac{1}{4}' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'الميل هو مشتقة الدالة:' },
        { t: 'math', v: 'y\' = -\\frac{1}{' },
      ],
    }),
    rubric: 'المشتقة الصحيحة والتعويض = 10 درجات. إذا كان التعبير الرياضي غير مكتمل أو غير مقروء (malformed)، يذكر ذلك في الملاحظات ولا تمنح درجات للقسم غير المقروء.',
    maxPoints: 10,
    expectedBand: 'low',
    minScore: 0,
    maxScore: 3,
    minConfidence: 0.5,
    mockVerdict: {
      score: 2,
      maxScore: 10,
      confidence: 0.8,
      feedback: 'المعادلة غير مكتملة وغير مقروءة رياضياً (رمز كسر ناقص الأقواس) ولم يتم إكمال التعويض أو إيجاد الميل المطلوب.',
      reasoning: 'Malformed equation block is unreadable',
    },
  },
  {
    id: 8,
    name: 'chemistry_balanced_vs_unbalanced',
    description: 'Chemistry: balanced equation vs unbalanced equation -> full vs partial',
    question: 'اكتب المعادلة الكيميائية الموزونة لتفاعل غاز الهيدروجين مع غاز الأكسجين لتكوين الماء.',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'المعادلة الموزونة:' },
        { t: 'chem', v: '2H2 + O2 -> 2H2O' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'معادلة التفاعل هي:' },
        { t: 'chem', v: 'H2 + O2 -> H2O' },
      ],
    }),
    rubric: 'كتابة المواد المتفاعلة والناتجة صحيحة = 4 درجات، وزن المعادلة بشكل صحيح (المعامل 2 لكل من H2 و H2O) = 6 درجات. المعادلة غير الموزونة تنال 4 درجات فقط.',
    maxPoints: 10,
    expectedBand: 'partial',
    minScore: 3,
    maxScore: 6,
    minConfidence: 0.6,
    mockVerdict: {
      score: 4,
      maxScore: 10,
      confidence: 0.9,
      feedback: 'المواد المتفاعلة والناتجة صحيحة، ولكن المعادلة الكيميائية غير موزونة حيث يلزم 2H2 + O2 -> 2H2O.',
      reasoning: 'Unbalanced chemical equation gets partial credit',
    },
  },
  {
    id: 9,
    name: 'alternative_valid_solution_method',
    description: 'Alternative valid method (completing the square vs formula) -> full',
    question: 'أوجد جذري المعادلة التربيعية: x^2 - 6x + 5 = 0',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'باستخدام القانون العام:' },
        { t: 'math', v: 'x = \\frac{6 \\pm \\sqrt{36 - 20}}{2} = \\frac{6 \\pm 4}{2} \\implies x = 5 \\text{ or } x = 1' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'بإكمال المربع:' },
        { t: 'math', v: '(x - 3)^2 - 9 + 5 = 0 \\implies (x - 3)^2 = 4 \\implies x - 3 = \\pm 2 \\implies x = 5 \\text{ أو } x = 1' },
      ],
    }),
    rubric: 'أي طريقة رياضية صحيحة مقبولة (القانون العام أو التحليل أو إكمال المربع). إيجاد الحلين 5 و 1 بخطوات سليمة = 10 درجات.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'طريقة إكمال المربع صحيحة وبديلة ممتازة وأدت إلى الجذور الصحيحة 5 و 1.',
      reasoning: 'Alternative valid method (completing square) accepted with full score',
    },
  },
  {
    id: 10,
    name: 'plain_text_answer_to_rich_question',
    description: 'Text-only answer to a RICH question -> graded as today',
    question: 'اشرح باختصار قانون نيوتن الأول للحركة واذكر معناه الفيزيائي.',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'قانون نيوتن الأول: يظل الجسم على حالته من سكون أو حركة منتظمة في خط مستقيم ما لم تؤثر عليه قوة محصلة تغير من حالته.' },
      ],
    }),
    studentAnswer: 'يبقى الجسم الساكن ساكناً والجسم المتحرك بسرعة منتظمة في خط مستقيم متحركاً ما لم تؤثر عليه قوة خارجية محصلة.',
    rubric: 'ذكر بقاء الجسم الساكن ساكنا = 5 درجات، ذكر شرط عدم وجود قوة محصلة تؤثر عليه = 5 درجات.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'إجابة نصية وافية وصحيحة علمياً تشرح مبدأ القصور الذاتي وقانون نيوتن الأول بدقة.',
      reasoning: 'Plain text answer to rich question evaluated fully',
    },
  },
  {
    id: 11,
    name: 'mixed_arabic_prose_and_math',
    description: 'Arabic prose mixed with equations -> graded on content',
    question: 'أوجد مساحة مستطيل طوله ضعف عرضه ومحيطه 24 سم.',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'نفرض العرض w فيكون الطول 2w' },
        { t: 'math', v: '2(w + 2w) = 24 \\implies 6w = 24 \\implies w = 4' },
        { t: 'text', v: 'المساحة هي:' },
        { t: 'math', v: 'A = 4 \\times 8 = 32\\text{ cm}^2' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'نفرض أن عرض المستطيل هو س، وبالتالي يكون الطول 2س.' },
        { t: 'text', v: 'بما أن المحيط = 2(الطول + العرض):' },
        { t: 'math', v: '2(س + 2س) = 24 \\implies 6س = 24 \\implies س = 4' },
        { t: 'text', v: 'إذن العرض 4 سم والطول 8 سم. المساحة تساوي الطول في العرض:' },
        { t: 'math', v: 'المساحة = 4 \\times 8 = 32\\text{ سم}^2' },
      ],
    }),
    rubric: 'صياغة المعادلة والحل س=4 = 5 درجات، حساب الأبعاد والمساحة 32 = 5 درجات.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'شرح لغوي ورياضي ممتاز باللغة العربية متكامل مع المعادلات، والنتيجة 32 سم² صحيحة تماماً.',
      reasoning: 'Mixed prose and equations graded on substance',
    },
  },
  {
    id: 12,
    name: 'notation_variations_cdot_vs_times_dfrac',
    description: '\\cdot vs \\times, \\dfrac vs \\frac -> no deduction',
    question: 'احسب حاصل ضرب الكسرين التاليين: \\frac{3}{4} \\times \\frac{2}{5}',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'math', v: '\\frac{3}{4} \\times \\frac{2}{5} = \\frac{6}{20} = \\frac{3}{10}' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'math', v: '\\dfrac{3}{4} \\cdot \\dfrac{2}{5} = \\dfrac{3 \\cdot 2}{4 \\cdot 5} = \\dfrac{3}{10}' },
      ],
    }),
    rubric: 'حساب الناتج واختصاره إلى 3/10 = 10 درجات. لا يخصم أي شيء لاختلاف نمط الرموز مثل dfrac أو cdot.',
    maxPoints: 10,
    expectedBand: 'full',
    minScore: 9,
    maxScore: 10,
    minConfidence: 0.6,
    mockVerdict: {
      score: 10,
      maxScore: 10,
      confidence: 0.95,
      feedback: 'حساب صحيح تماماً واختصار دقيق، ولا خصم لاختلاف الرموز (cdot أو dfrac).',
      reasoning: 'Notation variations dfrac and cdot accepted with no deduction',
    },
  },
  {
    id: 13,
    name: 'indefinite_integral_missing_constant_C',
    description: 'Indefinite integral missing +C where the rubric requires it -> deducted',
    question: 'أوجد التكامل غير المحدد التالي: \\int (3x^2 + 2x) \\, dx',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'التكامل غير المحدد:' },
        { t: 'math', v: '\\int (3x^2 + 2x) \\, dx = x^3 + x^2 + C' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'ناتج التكامل هو:' },
        { t: 'math', v: 'x^3 + x^2' },
      ],
    }),
    rubric: 'تكامل 3x^2 هو x^3 = 4 درجات، تكامل 2x هو x^2 = 4 درجات، كتابة ثابت التكامل +C مطلوبة في التكامل غير المحدد وتستحق درجتين.',
    maxPoints: 10,
    expectedBand: 'deducted',
    minScore: 7,
    maxScore: 8.5,
    minConfidence: 0.6,
    mockVerdict: {
      score: 8,
      maxScore: 10,
      confidence: 0.9,
      feedback: 'خطوات المكاملة صحيحة تماماً لكن تم خصم درجتين لعدم كتابة ثابت التكامل (+C) المطلوب في التكامل غير المحدد.',
      reasoning: 'Missing constant of integration +C deducted',
    },
  },
  {
    id: 14,
    name: 'physics_vector_direction_wrong',
    description: 'Physics vector direction wrong -> partial',
    question: 'تتحرك سيارة بسرعة 20 m/s نحو الشرق ثم انعطفت لتتحرك بنفس السرعة نحو الشمال. ما هو متجه التغير في السرعة \\Delta \\vec{v}؟',
    reference: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'التغير في متجه السرعة:' },
        { t: 'math', v: '\\Delta \\vec{v} = \\vec{v}_2 - \\vec{v}_1 = 20\\hat{j} - 20\\hat{i}' },
        { t: 'text', v: 'المقدار هو 20\\sqrt{2} m/s والاتجاه شمال غرب.' },
      ],
    }),
    studentAnswer: JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'مقدار التغير في السرعة هو:' },
        { t: 'math', v: '|\\Delta v| = \\sqrt{20^2 + 20^2} = 20\\sqrt{2}\\text{ m/s}' },
        { t: 'text', v: 'والاتجاه هو نحو الجنوب الشرقي.' },
      ],
    }),
    rubric: 'حساب المقدار الصحيح 20sqrt(2) m/s = 5 درجات، تحديد الاتجاه الصحيح شمال غرب = 5 درجات. تحديد اتجاه خاطئ يخصم 5 درجات.',
    maxPoints: 10,
    expectedBand: 'partial',
    minScore: 4,
    maxScore: 6,
    minConfidence: 0.5,
    mockVerdict: {
      score: 5,
      maxScore: 10,
      confidence: 0.85,
      feedback: 'حساب مقدار المتجه (20√2 m/s) صحيح، ولكن الاتجاه المحدد (الجنوب الشرقي) غير صحيح والاتجاه الصحيح هو شمال غرب.',
      reasoning: 'Vector magnitude correct but direction wrong gives partial credit',
    },
  },
];

module.exports = {
  GOLDEN_CASES,
};
