'use strict';

/**
 * seed-thanaweya-math-exam.js
 *
 * Seeds a comprehensive 20-question Egyptian 3rd Secondary (تالتة ثانوي)
 * Mathematics exam for Gate 3 hands-on testing of the visual math editor.
 *
 * Breakdown (20 questions, 100 points total):
 * - 10 MCQs (radiogroup, 5 pts each): Algebra, Calculus, Statics, Dynamics
 * - 10 Essay questions (comment with answerFormat: "RICH", 5 pts each):
 *     1. Differentiation & Related Rates (تفاضل ومعدلات زمنية)
 *     2. Curve Sketching & Extrema (سلوك الدوال ونقط الانقلاب)
 *     3. Definite & Indefinite Integration (تكامل محدد وغير محدد)
 *     4. Areas & Volumes of Revolution (مساحات وحجوم دورانية)
 *     5. Vector Analysis in 3D (متجهات في الفراغ)
 *     6. Lines & Planes in Space (خطوط ومستويات في الفراغ)
 *     7. Friction & Moments (احتكاك وعزوم)
 *     8. General Equilibrium (اتزان عام وقضيب منتظم)
 *     9. Newton's Laws & Connected Motion (قوانين نيوتن وحركة بكرات)
 *    10. Work, Energy, & Impulse (شغل وطاقة ودفع وتصادم)
 */

require('dotenv').config();
const prisma = require('../src/config/db');
const { validateSurveyJson, buildAnswerKey } = require('../src/services/quizService');
const { serializeRich } = require('../src/lib/richContent/serialize');
const { randomBase36Slug } = require('../src/utils/slugs');

const QUIZ_TITLE = 'امتحان الرياضيات - الثانوية العامة (تالتة ثانوي)';

const QUESTIONS = [
  // ─── 10 MCQs (5 points each = 50 pts) ──────────────────────────────────────
  {
    type: 'radiogroup',
    name: 'mcq_algebra_permutations',
    topic: 'Algebra - Permutations & Combinations',
    title: 'إذا كان $^n P_3 = 24 \\times ^n C_4$ ، فإن قيمة $n$ تساوي:',
    choices: ['4', '5', '6', '7'],
    correctValue: '4',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_algebra_complex_numbers',
    topic: 'Algebra - Complex Numbers Argument',
    title: 'السعة الأساسية للعدد المركب $z = -1 + \\sqrt{3}i$ تساوي:',
    choices: ['\\frac{\\pi}{3}', '\\frac{2\\pi}{3}', '-\\frac{2\\pi}{3}', '\\frac{5\\pi}{6}'],
    correctValue: '\\frac{2\\pi}{3}',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_calculus_differentiation',
    topic: 'Calculus - Chain Rule & Exponential Functions',
    title: 'إذا كانت $y = e^{\\sin(2x)}$ فإن $\\frac{dy}{dx}$ عند $x = 0$ تساوي:',
    choices: ['0', '1', '2', 'e'],
    correctValue: '2',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_calculus_limits_euler',
    topic: 'Calculus - Euler Limit Definition',
    title: 'قيمة النهاية $\\lim_{x \\to 0} (1 + 3x)^{\\frac{2}{x}}$ تساوي:',
    choices: ['e^{2}', 'e^{3}', 'e^{5}', 'e^{6}'],
    correctValue: 'e^{6}',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_geometry_sphere',
    topic: 'Solid Geometry - Sphere Equation & Center',
    title: 'مركز الكرة التي معادلتها $x^2 + y^2 + z^2 - 4x + 6y - 8z + 4 = 0$ هو:',
    choices: ['(2, -3, 4)', '(-2, 3, -4)', '(4, -6, 8)', '(2, 3, 4)'],
    correctValue: '(2, -3, 4)',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_geometry_orthogonal_vectors',
    topic: 'Solid Geometry - Dot Product & Perpendicular Vectors',
    title: 'إذا كان المتجهان $\\vec{A} = (2, m, -4)$ و $\\vec{B} = (3, 2, 1)$ متعامدين، فإن قيمة $m$ تساوي:',
    choices: ['-1', '1', '-2', '2'],
    correctValue: '-1',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_statics_friction_angle',
    topic: 'Statics - Rough Horizontal Plane & Friction Angle',
    title: 'وضع جسم وزنه $20\\text{ N}$ على مستوى أفقي خشن، وكان معامل الاحتكاك السكوني $\\mu_s = \\frac{\\sqrt{3}}{3}$. فإن زاوية الاحتكاك السكوني $\\lambda$ تساوي:',
    choices: ['30^\\circ', '45^\\circ', '60^\\circ', '75^\\circ'],
    correctValue: '30^\\circ',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_statics_moment_2d',
    topic: 'Statics - Moment of Force About Origin',
    title: 'إذا كانت القوة $\\vec{F} = 3\\hat{i} - 4\\hat{j}$ تؤثر في النقطة $A(1, 2)$، فإن متجه عزم القوة حول نقطة الأصل $O$ يساوي:',
    choices: ['-10\\hat{k}', '10\\hat{k}', '-2\\hat{k}', '2\\hat{k}'],
    correctValue: '-10\\hat{k}',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_dynamics_instantaneous_rest',
    topic: 'Dynamics - Straight Line Kinematics & Instantaneous Rest',
    title: 'يتحرك جسيم في خط مستقيم بحيث كان موضعه $s(t) = t^3 - 6t^2 + 9t$. فإن الجسيم يسكن لحظياً عند $t$ تساوي:',
    choices: ['1 s and 3 s', '2 s only', '3 s only', '0 s and 3 s'],
    correctValue: '1 s and 3 s',
    points: 5
  },
  {
    type: 'radiogroup',
    name: 'mcq_dynamics_impulse_momentum',
    topic: 'Dynamics - Impulse & Change in Momentum',
    title: 'أثرت قوة ثابتة مقدارها $15\\text{ N}$ على جسم ساكن كتلته $3\\text{ kg}$ لمدة $4\\text{ s}$. فإن مقدار التغير في كمية حركة الجسم يساوي:',
    choices: ['20 N.s', '45 N.s', '60 N.s', '180 N.s'],
    correctValue: '60 N.s',
    points: 5
  },

  // ─── 10 Essay Questions (5 points each = 50 pts) ───────────────────────────
  {
    type: 'comment',
    name: 'essay_diff_related_rates',
    topic: '1. Differentiation & Related Rates (تفاضل ومعدلات زمنية)',
    title: 'سلم منتظم طوله $5\\text{ m}$ يستند بطرفه العلوي على حائط رأسي وبطرفه السفلي على أرض أفقية. فإذا انزلق الطرف السفلي مبتعداً عن الحائط بمعدل $2\\text{ m/s}$، أوجد معدل انزلاق الطرف العلوي للسلم ومعدل تغير قياس زاوية ميل السلم على الأرض عندما يكون الطرف السفلي على بعد $3\\text{ m}$ من الحائط.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان للعلاقة الهندسية واشتقاقها، درجتان لحساب معدل انزلاق الطرف العلوي (-1.5 m/s)، ودرجة لحساب معدل تغير زاوية الميل (-0.5 rad/s).',
    modelAnswerBlocks: [
      { t: 'text', v: 'بفرض أن بُعد الطرف السفلي عن الحائط هو x وارتفاع الطرف العلوي هو y وزاوية ميل السلم هي \\theta:' },
      { t: 'math', v: 'x^2 + y^2 = 5^2 = 25' },
      { t: 'text', v: 'عندما x = 3 m يكون y = 4 m. بالتفاضل بالنسبة للزمن t:' },
      { t: 'math', v: '2x\\frac{dx}{dt} + 2y\\frac{dy}{dt} = 0 \\implies 3(2) + 4\\frac{dy}{dt} = 0 \\implies \\frac{dy}{dt} = -1.5\\text{ m/s}' },
      { t: 'text', v: 'معدل انزلاق الطرف العلوي هو 1.5 m/s لأسفل. لحساب معدل تغير قياس الزاوية \\theta:' },
      { t: 'math', v: '\\tan\\theta = \\frac{y}{x} \\implies \\sec^2\\theta \\frac{d\theta}{dt} = \\frac{x\\frac{dy}{dt} - y\\frac{dx}{dt}}{x^2}' },
      { t: 'math', v: '\\left(\\frac{5}{3}\\right)^2 \\frac{d\theta}{dt} = \\frac{3(-1.5) - 4(2)}{9} = -\\frac{12.5}{9} \\implies \\frac{d\theta}{dt} = -0.5\\text{ rad/s}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_curve_extrema_inflection',
    topic: '2. Curve Sketching & Extrema (سلوك الدوال ونقط الانقلاب)',
    title: 'عَيّن فترات التزايد والتناقص، والنقط الحرجة، والقيم العظمى والصغرى المحلية، وفترات التحدب لأعلى ولأسفل ونقط الانقلاب للمنحنى: $f(x) = x^3 - 3x^2 - 9x + 5$',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان للمشتقة الأولى والنقط الحرجة وفترات التزايد/التناقص، درجتان للقيم العظمى والصغرى المحلية، ودرجة للمشتقة الثانية والتحدب ونقطة الانقلاب.',
    modelAnswerBlocks: [
      { t: 'text', v: 'المشتقة الأولى لدراسة التزايد والتناقص:' },
      { t: 'math', v: 'f\'(x) = 3x^2 - 6x - 9 = 3(x - 3)(x + 1)' },
      { t: 'text', v: 'النقط الحرجة عند x = -1 و x = 3. الدالة تزايدية في (-\\\\infty, -1) و (3, \\\\infty)، وتناقصية في (-1, 3).' },
      { t: 'text', v: 'قيمة عظمى محلية عند x = -1: f(-1) = 10. قيمة صغرى محلية عند x = 3: f(3) = -22.' },
      { t: 'text', v: 'المشتقة الثانية لدراسة التحدب والانقلاب:' },
      { t: 'math', v: 'f\'\'(x) = 6x - 6 = 6(x - 1)' },
      { t: 'text', v: 'المنحنى محدب لأعلى في (-\\\\infty, 1) ومحدب لأسفل في (1, \\\\infty)، وتوجد نقطة انقلاب عند (1, -6).' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_integration_methods',
    topic: '3. Definite & Indefinite Integration (تكامل محدد وغير محدد)',
    title: 'أوجد قيمة كل من التكاملين الآتيين موضّحاً خطوات الحل كاملة:\n(أ) $\\int x^2 e^{2x} \\,dx$\n(ب) $\\int_{0}^{\\pi/4} \\tan^3(x) \\sec^2(x) \\,dx$',
    answerFormat: 'RICH',
    points: 5,
    rubric: '3 درجات للفقرة (أ) التكامل بالتجزيء على مرحلتين مع ثابت التكامل، ودرجتان للفقرة (ب) التكامل بالتعويض والناتج النهائي 1/4.',
    modelAnswerBlocks: [
      { t: 'text', v: '(أ) بالتكامل بالتجزيء مرتين:' },
      { t: 'math', v: '\\int x^2 e^{2x}dx = \\frac{1}{2}x^2 e^{2x} - \\int x e^{2x}dx = \\frac{1}{2}x^2 e^{2x} - \\left(\\frac{1}{2}x e^{2x} - \\frac{1}{4}e^{2x}\\right) + C' },
      { t: 'math', v: '= e^{2x}\\left(\\frac{1}{2}x^2 - \\frac{1}{2}x + \\frac{1}{4}\\right) + C' },
      { t: 'text', v: '(ب) بالتكامل بالتعويض: بفرض u = \\tan x فتكون du = \\sec^2 x dx:' },
      { t: 'math', v: '\\int_{0}^{\\pi/4} \\tan^3(x)\\sec^2(x)dx = \\int_{0}^{1} u^3 du = \\left[\\frac{u^4}{4}\\right]_0^1 = \\frac{1}{4}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_volumes_of_revolution',
    topic: '4. Areas & Volumes of Revolution (مساحات وحجوم دورانية)',
    title: 'أوجد حجم الجسم الناشئ من دوران المنطقة المحصورة بين منحنى الدالة $y = \\sqrt{x}$ والمستقيم $y = \\frac{1}{2}x$ دورة كاملة حول محور السينات.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجة لإيجاد نقط التقاطع (0 و 4)، درجتان لكتابة صيغة التكامل المحدود، ودرجتان لحساب ناتج التكامل النهائي (8pi/3).',
    modelAnswerBlocks: [
      { t: 'text', v: 'إيجاد نقط التقاطع:' },
      { t: 'math', v: '\\sqrt{x} = \\frac{1}{2}x \\implies x = \\frac{1}{4}x^2 \\implies x(x - 4) = 0 \\implies x = 0, \\; x = 4' },
      { t: 'text', v: 'حجم الجسم الدوراني حول محور السينات:' },
      { t: 'math', v: 'V = \\pi \\int_{0}^{4} \\left[(\\sqrt{x})^2 - \\left(\\frac{1}{2}x\\right)^2\\right] dx = \\pi \\int_{0}^{4} \\left(x - \\frac{1}{4}x^2\\right) dx' },
      { t: 'math', v: 'V = \\pi \\left[\\frac{x^2}{2} - \\frac{x^3}{12}\\right]_0^4 = \\pi \\left(8 - \\frac{16}{3}\\right) = \\frac{8\\pi}{3}\\text{ وحدة حجم}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_vectors_triangle_area',
    topic: '5. Vector Analysis in 3D (متجهات في الفراغ)',
    title: 'إذا كانت النقاط $A(1, -1, 2)$ و $B(2, 1, -1)$ و $C(3, -1, 2)$ رؤوس مثلث في الفراغ:\n(أ) أوجد المتجهين $\\vec{AB}$ و $\\vec{AC}$.\n(ب) احسب الضرب الاتجاهي $\\vec{AB} \\times \\vec{AC}$.\n(جـ) احسب مساحة المثلث $ABC$.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجة لحساب المتجهين، درجتان لحساب الضرب الاتجاهي، ودرجتان لحساب مساحة المثلث (جذر 13).',
    modelAnswerBlocks: [
      { t: 'text', v: '(أ) حساب المتجهين:' },
      { t: 'math', v: '\\vec{AB} = B - A = (1, 2, -3), \\quad \\vec{AC} = C - A = (2, 0, 0)' },
      { t: 'text', v: '(ب) حاصل الضرب الاتجاهي:' },
      { t: 'math', v: '\\vec{AB} \\times \\vec{AC} = \\begin{vmatrix} \\hat{i} & \\hat{j} & \\hat{k} \\\\ 1 & 2 & -3 \\\\ 2 & 0 & 0 \\end{vmatrix} = -6\\hat{j} - 4\\hat{k} = (0, -6, -4)' },
      { t: 'text', v: '(جـ) مساحة المثلث ABC:' },
      { t: 'math', v: '\\text{Area} = \\frac{1}{2}\\|\\vec{AB} \\times \\vec{AC}\\| = \\frac{1}{2}\\sqrt{0 + 36 + 16} = \\frac{1}{2}\\sqrt{52} = \\sqrt{13}\\text{ وحدة مساحة}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_line_plane_intersection',
    topic: '6. Lines & Planes in Space (خطوط ومستويات في الفراغ)',
    title: 'أوجد معادلة الخط المستقيم المار بالنقطة $P(1, 2, -1)$ والعمودي على المستوى $2x - 3y + z = 7$. ثم عيّن إحداثيات نقطة تقاطع هذا المستقيم مع المستوى.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان لمعادلة المستقيم الاتجاهية والبارامترية، درجتان للتعويض في المستوى وحساب t = 6/7، ودرجة لإحداثيات نقطة التقاطع.',
    modelAnswerBlocks: [
      { t: 'text', v: 'متجه الاتجاه العمودي على المستوى هو اتجاه المستقيم:' },
      { t: 'math', v: '\\vec{d} = (2, -3, 1) \\implies \\vec{r} = (1, 2, -1) + t(2, -3, 1)' },
      { t: 'text', v: 'المعادلات البارامترية: x = 1 + 2t, y = 2 - 3t, z = -1 + t. بالتعويض في معادلة المستوى:' },
      { t: 'math', v: '2(1 + 2t) - 3(2 - 3t) + (-1 + t) = 7 \\implies 14t - 5 = 7 \\implies t = \\frac{6}{7}' },
      { t: 'text', v: 'إحداثيات نقطة التقاطع:' },
      { t: 'math', v: '\\left(\\frac{19}{7}, -\\frac{4}{7}, -\\frac{1}{7}\\right)' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_inclined_friction',
    topic: '7. Friction & Moments (احتكاك وعزوم)',
    title: 'وضع جسم كتلته $12\\text{ kg}$ على مستوى مائل خشن يميل على الأفقي بزاوية قياسها $30^\\circ$. أثرت على الجسم قوة موازية للمستوى ولأعلى جعلت الجسم على وشك الحركة لأعلى المستوى. فإذا كان معامل الاحتكاك السكوني $\\mu_s = \\frac{\\sqrt{3}}{6}$، أوجد مقدار هذه القوة بالنيوتن (باعتبار $g = 9.8\\text{ m/s}^2$).',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجة لحساب الوزن ورد الفعل العمودي، درجتان لحساب قوة الاحتكاك النهائي، ودرجتان لمعادلة الاتزان والناتج النهائي (88.2 N).',
    modelAnswerBlocks: [
      { t: 'text', v: 'وزن الجسم ورد الفعل العمودي:' },
      { t: 'math', v: 'W = 12 \\times 9.8 = 117.6\\text{ N}, \\quad R = W \\cos 30^\\circ = 58.8\\sqrt{3}\\text{ N}' },
      { t: 'text', v: 'بما أن الحركة وشيكة لأعلى، فإن الاحتكاك النهائي F_s يعمل لأسفل المستوى:' },
      { t: 'math', v: 'F_s = \\mu_s R = \\frac{\\sqrt{3}}{6} \\times 58.8\\sqrt{3} = 29.4\\text{ N}' },
      { t: 'text', v: 'معادلة الاتزان في اتجاه خط أكبر ميل:' },
      { t: 'math', v: 'P = F_s + W \\sin 30^\\circ = 29.4 + 58.8 = 88.2\\text{ N}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_general_equilibrium_rod',
    topic: '8. General Equilibrium (اتزان عام وقضيب منتظم)',
    title: 'قضيب منتظم $AB$ طوله $4\\text{ m}$ ووزنه $200\\text{ N}$ يرتكز بطرفه $A$ على أرض أفقية خشنة معامل الاحتكاك معها $\\frac{1}{3}$، وبطرفه $B$ على حائط رأسي أملس. فإذا كان القضيب يميل على الأفقي بزاوية $45^\\circ$ في حالة توازن، أوجد رد فعل الحائط، ورد الفعل العمودي وقوة الاحتكاك عند $A$، وبيّن هل القضيب على وشك الانزلاق؟',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان لمعادلتي توازن القوى الأفقية والرأسية، درجتان لمعادلة العزوم وإيجاد R_B = 100 N، ودرجة للمقارنة مع أقصى احتكاك وبيان الانزلاق.',
    modelAnswerBlocks: [
      { t: 'text', v: 'شروط الاتزان العام:' },
      { t: 'math', v: 'R_A = 200\\text{ N}, \\quad F_r = R_B' },
      { t: 'text', v: 'بأخذ العزوم حول الطرف A:' },
      { t: 'math', v: '200 \\times (2 \\cos 45^\\circ) - R_B \\times (4 \\sin 45^\\circ) = 0 \\implies R_B = 100\\text{ N} \\implies F_r = 100\\text{ N}' },
      { t: 'text', v: 'قوة الاحتكاك السكوني القصوى المتاحة:' },
      { t: 'math', v: 'F_{s,\\max} = \\mu_s R_A = \\frac{1}{3} \\times 200 \\approx 66.67\\text{ N}' },
      { t: 'text', v: 'بما أن الاحتكاك المطلوب للاتزان (100 N) أكبر من أقصى احتكاك ممكن (66.67 N)، فالقضيب لا يتزن بمفرده وسينزلق.' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_newton_pulley_system',
    topic: '9. Newton\'s Laws & Connected Motion (قوانين نيوتن وحركة بكرات)',
    title: 'جسم كتلته $m_1 = 3\\text{ kg}$ موضوع على نضد أفقي أملس ومتصل بخيط خفيف غير مرن يمر على بكرة ملساء عند حافة النضد، ويتدلى منه رأسياً جسم كتلته $m_2 = 2\\text{ kg}$. بدأت المجموعة الحركة من سكون.\n(أ) احسب عجلة الحركة $a$ بوحدة $\\text{m/s}^2$ ($g = 9.8\\text{ m/s}^2$).\n(ب) احسب الشد في الخيط $T$ بالنيوتن.\n(جـ) احسب الضغط الواقع على البكرة.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان لمعادلتي الحركة وحساب العجلة (3.92 m/s²)، درجتان لحساب الشد (11.76 N)، ودرجة لحساب الضغط على البكرة (11.76√2 N).',
    modelAnswerBlocks: [
      { t: 'text', v: '(أ) معادلات حركة الجسمين:' },
      { t: 'math', v: 'm_2 g - T = m_2 a \\implies 19.6 - T = 2a, \\quad T = 3a' },
      { t: 'math', v: '19.6 = 5a \\implies a = 3.92\\text{ m/s}^2' },
      { t: 'text', v: '(ب) الشد في الخيط:' },
      { t: 'math', v: 'T = 3(3.92) = 11.76\\text{ N}' },
      { t: 'text', v: '(جـ) الضغط على البكرة:' },
      { t: 'math', v: 'P = \\sqrt{2}T = 11.76\\sqrt{2}\\text{ N} \\approx 16.63\\text{ N}' }
    ]
  },
  {
    type: 'comment',
    name: 'essay_impulse_work_energy',
    topic: '10. Work, Energy, & Impulse (شغل وطاقة ودفع وتصادم)',
    title: 'كرة ملساء كتلتها $0.5\\text{ kg}$ تتحرك في خط مستقيم بسرعة $8\\text{ m/s}$ اصطدمت عمودياً بحائط رأسي وارتدت بسرعة $5\\text{ m/s}$.\n(أ) احسب مقدار دفع الحائط على الكرة بوحدة $\\text{N}\\cdot\\text{s}$.\n(ب) إذا كان زمن التلامس $0.05\\text{ s}$، احسب متوسط القوة المؤثرة على الحائط.\n(جـ) احسب الفقد في طاقة الحركة بالجول.',
    answerFormat: 'RICH',
    points: 5,
    rubric: 'درجتان لحساب مقدار الدفع مع مراعاة الاتجاهات (6.5 N.s)، درجتان لحساب متوسط القوة (130 N)، ودرجة لحساب الفقد في طاقة الحركة (9.75 J).',
    modelAnswerBlocks: [
      { t: 'text', v: '(أ) مقدار الدفع يساوي التغير في كمية الحركة:' },
      { t: 'math', v: 'I = m|v_2 - v_1| = 0.5|5 - (-8)| = 0.5(13) = 6.5\\text{ N}\\cdot\\text{s}' },
      { t: 'text', v: '(ب) متوسط القوة المؤثرة:' },
      { t: 'math', v: 'F_{\\text{avg}} = \\frac{I}{\\Delta t} = \\frac{6.5}{0.05} = 130\\text{ N}' },
      { t: 'text', v: '(جـ) الفقد في طاقة الحركة:' },
      { t: 'math', v: 'KE_1 = \\frac{1}{2}(0.5)(8^2) = 16\\text{ J}, \\quad KE_2 = \\frac{1}{2}(0.5)(5^2) = 6.25\\text{ J}' },
      { t: 'math', v: '\\Delta KE = 16 - 6.25 = 9.75\\text{ J}' }
    ]
  }
];

function buildPayload() {
  const elements = QUESTIONS.map((q) => {
    if (q.type === 'radiogroup') {
      return {
        type: 'radiogroup',
        name: q.name,
        title: q.title,
        choices: q.choices,
      };
    }
    return {
      type: 'comment',
      name: q.name,
      title: q.title,
      answerFormat: q.answerFormat,
    };
  });

  const surveyJson = {
    title: QUIZ_TITLE,
    pages: [{ elements }],
  };

  const answerKeyInput = {};
  for (const q of QUESTIONS) {
    if (q.type === 'radiogroup') {
      answerKeyInput[q.name] = {
        type: 'radiogroup',
        correctValue: q.correctValue,
        points: q.points,
      };
    } else {
      answerKeyInput[q.name] = {
        type: 'comment',
        answerFormat: q.answerFormat,
        points: q.points,
        rubric: q.rubric,
        modelAnswer: serializeRich(q.modelAnswerBlocks),
      };
    }
  }

  return { surveyJson, answerKeyInput };
}

async function seedExam() {
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('Seeding Thanaweya Amma Mathematics Exam (20 questions)');
  console.log('─────────────────────────────────────────────────────────────────');

  // 1. Build & Validate payload
  const { surveyJson, answerKeyInput } = buildPayload();
  const sVal = validateSurveyJson(surveyJson);
  if (!sVal.ok) {
    throw new Error(`surveyJson validation failed: ${sVal.errors.join('; ')}`);
  }
  const kVal = buildAnswerKey(surveyJson, answerKeyInput);
  if (!kVal.ok) {
    throw new Error(`answerKey validation failed: ${kVal.errors.join('; ')}`);
  }
  console.log('Payload validated successfully: 10 MCQs + 10 Rich Essay questions.');

  // 2. Select target video
  const specifiedSlug = process.argv[2];
  let video;
  if (specifiedSlug) {
    video = await prisma.bunnyVideo.findUnique({
      where: { slug: specifiedSlug },
      include: { course: true, quiz: true },
    });
    if (!video) throw new Error(`Video with slug "${specifiedSlug}" not found`);
  } else {
    // Default to the first ready video in the database
    video = await prisma.bunnyVideo.findFirst({
      where: { status: 'READY' },
      include: { course: true, quiz: true },
      orderBy: { id: 'asc' },
    });
    if (!video) {
      throw new Error('No READY video found in database. Please run demo video upload script first.');
    }
  }

  console.log(`Target Video: #${video.id} "${video.title}" (slug: ${video.slug})`);
  console.log(`Course: #${video.course.id} "${video.course.title}" (slug: ${video.course.slug}, grade: ${video.course.grade})`);

  // 3. Upsert Quiz
  const existingQuiz = await prisma.quiz.findUnique({
    where: { bunnyVideoId: video.id },
  });

  const quizSlug = existingQuiz?.slug || randomBase36Slug();
  const quiz = await prisma.quiz.upsert({
    where: { bunnyVideoId: video.id },
    create: {
      bunnyVideoId: video.id,
      title: QUIZ_TITLE,
      slug: quizSlug,
      timeLimitSec: 3600, // 60 minutes
      passingScore: 50,
      maxAttempts: 3,
      surveyJson,
      answerKey: kVal.answerKey,
    },
    update: {
      title: QUIZ_TITLE,
      timeLimitSec: 3600,
      passingScore: 50,
      maxAttempts: 3,
      surveyJson,
      answerKey: kVal.answerKey,
    },
  });

  console.log(`\nQuiz upserted successfully:`);
  console.log(`  Quiz ID:   ${quiz.id}`);
  console.log(`  Title:     "${quiz.title}"`);
  console.log(`  Slug:      ${quiz.slug}`);
  console.log(`  Passing:   ${quiz.passingScore}%`);
  console.log(`  TimeLimit: ${quiz.timeLimitSec}s`);
  console.log(`  Attempts:  ${quiz.maxAttempts}`);

  // 4. Reset prior attempts on this quiz so user gets a fresh attempt
  const deletedAttempts = await prisma.quizAttempt.deleteMany({
    where: { quizId: quiz.id },
  });
  console.log(`Cleared ${deletedAttempts.count} existing quiz attempts for clean test state.`);

  // 5. Unlock video and enroll test students so gate checks pass immediately
  const testUsers = await prisma.user.findMany({
    where: {
      email: {
        in: [
          'admin@elearning.com',
          'ahmedosaied73@gmail.com',
          'seqaccess@localhost.test',
          'grader-demo@localhost.test',
        ],
      },
    },
  });

  for (const u of testUsers) {
    // Ensure enrollment
    await prisma.enrollment.upsert({
      where: { userId_courseId: { userId: u.id, courseId: video.courseId } },
      create: { userId: u.id, courseId: video.courseId, isPaid: true, paymentDate: new Date() },
      update: { isPaid: true },
    });

    // Ensure video completion (unlocks the quiz)
    await prisma.bunnyVideoProgress.upsert({
      where: { userId_bunnyVideoId: { userId: u.id, bunnyVideoId: video.id } },
      create: {
        userId: u.id,
        bunnyVideoId: video.id,
        completed: true,
        watchedAt: new Date(),
      },
      update: {
        completed: true,
        watchedAt: new Date(),
      },
    });
  }
  console.log(`Enrolled & unlocked quiz for ${testUsers.length} test accounts.`);

  // 6. Print summary & test URL
  const frontendQuizUrl = `http://localhost:3000/course/${video.course.slug}/video/${video.slug}/quiz`;
  console.log('\n=================================================================');
  console.log('THANAWEYA AMMA MATH EXAM SEED SUMMARY:');
  console.log('=================================================================');
  console.log(`Course Title:       ${video.course.title}`);
  console.log(`Course Slug:        ${video.course.slug}`);
  console.log(`Video Title:        ${video.title}`);
  console.log(`Video Slug:         ${video.slug}`);
  console.log(`Quiz Title:         ${quiz.title}`);
  console.log(`Quiz Slug:          ${quiz.slug}`);
  console.log(`Questions Count:    20 total`);
  console.log(`  - MCQs:           10 questions (5 points each, total 50 pts)`);
  console.log(`  - Essay:          10 questions (answerFormat: "RICH", 5 points each, total 50 pts)`);
  console.log(`Total Points:       100 pts`);
  console.log(`Passing Score:      50% (50 pts)`);
  console.log(`Time Limit:         60 minutes (3600s)`);
  console.log(`Frontend Test URL:  ${frontendQuizUrl}`);
  console.log('=================================================================\n');

  return {
    quizId: quiz.id,
    quizSlug: quiz.slug,
    courseSlug: video.course.slug,
    videoSlug: video.slug,
    frontendQuizUrl,
  };
}

if (require.main === module) {
  seedExam()
    .catch((err) => {
      console.error('\nSeeding failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { seedExam, QUESTIONS, buildPayload };
