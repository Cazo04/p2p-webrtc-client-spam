const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    //devtools: true,
    headless: false,
    args: [
      "--mute-audio",
      '--disable-setuid-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows'
    ]
  });

  // URL video - thay đổi thành URL video của bạn
  const videoUrl = 'http://localhost:5173/video/watch/m-0196eca9-6f61-7387-9eb4-776d2ae1ce6d';

  const NUM_TABS = 5;

  // Mảng lưu trữ các page
  const pages = [];

  // Tạo 5 tab
  console.log('Tạo 5 tab...');
  for (let i = 1; i <= NUM_TABS; i++) {
    const page = await browser.newPage();
    pages.push(page);
    console.log(`Tab ${i} được tạo`);
  }

  // Hàm chờ video hoàn thành
  async function waitForVideoToComplete(page, tabNumber) {
    try {
      // Điều hướng đến video
      await page.goto(videoUrl, { waitUntil: 'networkidle2' });
      console.log(`Tab ${tabNumber}: Trang video đã tải`);
      const randomDelay = Math.floor(Math.random() * 100) + 200;   
      console.log(`Tab ${tabNumber}: Chờ thêm ${randomDelay}ms trước khi tương tác`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      await page.bringToFront();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Chờ phần tử video xuất hiện
      await page.waitForSelector('video', { timeout: 10000 });
      console.log(`Tab ${tabNumber}: Tìm thấy phần tử video`);

      // Phát video
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) {
          video.play();
        }
      });
      console.log(`Tab ${tabNumber}: Video bắt đầu phát`);

      // Lấy thời lượng video
      const duration = await page.evaluate(() => {
        const video = document.querySelector('video');
        return video ? video.duration : 0;
      }) || 10;

      console.log(`Tab ${tabNumber}: Thời lượng video: ${duration}s`);

      // Chờ cho đến khi video kết thúc
      // Thêm 2 giây buffer để đảm bảo video hoàn toàn kết thúc
      const waitTime = (duration + 2) * 1000;
      console.log(`Tab ${tabNumber}: Chờ ${waitTime / 1000}s để video kết thúc`);

      await new Promise(resolve => setTimeout(resolve, waitTime));

      console.log(`Tab ${tabNumber}: Video đã kết thúc`);

    } catch (error) {
      console.error(`Tab ${tabNumber}: Lỗi -`, error.message);
    }
  }

  // Chạy video trên tất cả các tab song song
  console.log('\n--- Bắt đầu phát video trên 5 tab ---');
  const playPromises = pages.map((page, index) =>
    waitForVideoToComplete(page, index + 1)
  );

  // Chờ tất cả video hoàn thành
  await Promise.all(playPromises);

  console.log('\n--- Tất cả video đã kết thúc, đóng trình duyệt ---');

  // Đóng tất cả các tab
  for (let i = 0; i < pages.length; i++) {
    await pages[i].close();
    console.log(`Tab ${i + 1} đã đóng`);
  }

  // Đóng trình duyệt
  await browser.close();
  console.log('Trình duyệt đã đóng');
})();
