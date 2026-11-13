# GeneSense — handoff Trợ lý AI

Cập nhật: 02/11/2026. Tài liệu này mô tả bản trên nhánh `feature/ai-assistant-responsive` của checkout GS1, dựa trên bản yosidalogarit `ece9305`. Đọc cùng [HANDOFF.md](HANDOFF.md) để biết bối cảnh sản phẩm. Các ghi chú cũ trong HANDOFF.md có thể nói về một commit hoặc môi trường khác; kiểm tra mã nguồn và cấu hình hiện tại trước khi triển khai.

## Mục đích và giới hạn

**Trợ lý AI** giúp người dùng đối chiếu thông tin sức khỏe họ đã lưu và chuẩn bị câu hỏi cho bác sĩ. Đây không phải công cụ chẩn đoán, xác nhận hay loại trừ ung thư hoặc bệnh di truyền; không cho xác suất mắc bệnh, không suy đoán biến thể gen, không kê đơn hoặc đề nghị đổi thuốc. Số đo bình thường không loại trừ bệnh. Kết quả AI có thể sai và cần được người dùng kiểm tra với hồ sơ gốc và nhân viên y tế.

Tính năng chỉ chạy khi người dùng bấm **Phân tích hồ sơ** và đồng ý gửi dữ liệu cho **lần đó**. Không tự gửi dữ liệu hoặc phân tích mỗi khi mở app. Tài khoản dùng thử không được gọi AI. Người xem hồ sơ chia sẻ không được mở mục này.

## Dữ liệu được tổng hợp

Backend đọc dữ liệu thuộc tài khoản đang đăng nhập, không lấy dữ liệu tài khoản khác:

| Nguồn | Phạm vi gửi cho AI |
| --- | --- |
| Hồ sơ | Tuổi, giới tính, thể trạng, ghi chú cá nhân, nguy cơ tổng hợp có sẵn |
| Di truyền | Tiền sử gia đình, quan hệ huyết thống của cha mẹ, ghi chú bên nội và bên ngoại |
| Chỉ số | Tối đa 10 lần đo mới nhất, gồm thời điểm và các giá trị đã lưu |
| Giấy tờ | Tối đa 5 bản phân tích giấy tờ đã lưu: loại, ngày, tóm tắt, chỉ số, tình trạng và cảnh báo |
| Thuốc | Tối đa 30 thuốc trong lịch và 30 lần ghi nhận đã uống gần nhất |

Backend không đưa email, tên hiển thị hoặc **ảnh giấy tờ gốc** trực tiếp vào yêu cầu tổng hợp. Tuy nhiên, ghi chú tự do, tên thuốc và nội dung đã trích từ ảnh **vẫn có thể chứa thông tin định danh**; hiện chưa có bước tự động xóa hết thông tin cá nhân. Giao diện nhắc người dùng kiểm tra dữ liệu trước khi đồng ý. Giấy tờ đã lưu có nguồn là AI đọc từ ảnh, không phải dữ kiện đã được bác sĩ xác minh.

Người dùng chọn một trọng tâm (`overview`, `family`, `readings`, `documents`, `medications`) và có thể nhập câu hỏi tối đa 500 ký tự. Trọng tâm và câu hỏi được coi là dữ liệu cần giải thích, không phải chỉ dẫn điều khiển mô hình. Lời nhắc hệ thống yêu cầu nêu căn cứ, chỗ chưa chắc, mâu thuẫn giữa các nguồn và dữ liệu còn thiếu; giới hạn tối đa 5 phát hiện. Phản hồi phải khớp JSON schema trước khi lưu.

## Luồng và mã nguồn

1. `frontend/index.html` có mục **Trợ lý AI** trong menu, lối vào từ **Hôm nay**, biểu mẫu, kết quả và lịch sử.
2. `frontend/js/app.js` hiển thị số nguồn dữ liệu, yêu cầu chọn ô đồng ý cho mỗi lần phân tích, gửi yêu cầu, hiển thị kết quả, xem và xóa lịch sử. `frontend/js/api.js` chứa các lệnh API.
3. `POST /api/clinical-review` trong `backend/app/main.py` xác thực phiên, hồ sơ đã hoàn thành, tài khoản thật, AI đã cấu hình và `consent: true`. Backend tổng hợp dữ liệu rồi gọi `AIInsightService.review_clinical_context()` trong `backend/app/services/ai_service.py`.
4. Kết quả có `summary`, tối đa 5 `findings` (chủ đề, căn cứ, diễn giải, bước tiếp theo), tối đa 5 `missing_data`, `sources` và lời nhắc giới hạn y tế. Bản phân tích được lưu trong bảng `clinical_reviews` theo `user_id`; không lưu bản sao ảnh gốc ở bảng này.
5. `GET /api/clinical-reviews` trả tối đa 20 bản gần nhất. `DELETE /api/clinical-reviews/{id}` chỉ xóa bản thuộc tài khoản đang đăng nhập. `backend/app/migrations.py` dùng metadata để tạo bảng mới khi ứng dụng khởi động.

Những API này yêu cầu phiên đăng nhập. Mã lỗi chính: `401` chưa đăng nhập, `409` chưa hoàn thành hồ sơ, `403` tài khoản dùng thử, `422` thiếu/không đồng ý, `503` AI chưa cấu hình hoặc nhà cung cấp lỗi. Không có kết quả giả khi AI chưa khả dụng.

## Cấu hình và kiểm thử

- Cấu hình ở `.env` phía backend theo `.env.example`: mặc định `AI_PROVIDER=google`, cần `GOOGLE_AI_API_KEY`; có thể dùng `AI_PROVIDER=openai` và `OPENAI_API_KEY`. Không đưa khóa vào Git, frontend hoặc tài liệu.
- Khởi động tại repo: `.venv/Scripts/python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000` trên Windows. Xem `README.md` cho hướng dẫn đầy đủ và biến môi trường triển khai.
- Kiểm tra trước khi đẩy: `node --check frontend/js/app.js`, `node --check frontend/js/api.js`, `git diff --check`, `.venv/Scripts/python.exe -m pytest backend/tests -q`.
- Bộ test mới kiểm tra đồng ý, tài khoản dùng thử, thiếu cấu hình, tách tài khoản, lưu/xóa lịch sử và phản hồi có cấu trúc. Các bài test thay thế lời gọi AI bằng mô phỏng; **chưa chứng minh độ chính xác y khoa, độ chính xác của Gemini/OpenAI trên hồ sơ thật hoặc hoạt động production**.

## UI và việc còn lại

Giao diện giữ màu GeneSense, bố cục hai cột trên laptop và một cột trên điện thoại. Trang Hôm nay có thẻ mở Trợ lý AI; phần Lịch sử đo giấu chú giải và tóm tắt huyết áp tuần khi chưa có dữ liệu. PWA cache ở `frontend/sw.js` là `genesense-v76`. Đã kiểm tra sáu màn hình ở 320 px, không tràn ngang. Cần kiểm thử thêm bằng tài khoản thật có quyền đồng ý, khóa AI hợp lệ và dữ liệu tổng hợp đa dạng trước khi coi tính năng sẵn sàng cho người dùng thật.

Không dùng kết quả AI làm bằng chứng chẩn đoán hoặc lời khuyên điều trị. Nếu muốn đánh giá bệnh di truyền, cần quy trình lâm sàng, dữ liệu xét nghiệm được xác nhận và đánh giá riêng về độ chính xác, sai lệch và bảo mật.
