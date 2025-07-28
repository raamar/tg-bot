up:
	docker compose up --build

up-prod:
	docker compose -f docker-compose.prod.yml up --build -d

down:
	docker compose down

restart:
	docker compose restart

down-hard:
	@read -p "⚠️  Это удалит все данные! Продолжить? (y/N): " confirm && \
	if [ "$$confirm" = "y" ]; then \
		docker compose down -v; \
	else \
		echo "Операция отменена."; \
	fi

studio:
	docker compose exec bot npx prisma studio

logs:
	docker compose logs -f --tail=100

