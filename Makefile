up:
	docker compose -f docker-compose.prod.yml up --build -d

down:
	docker compose -f docker-compose.prod.yml down

restart:
	docker compose -f docker-compose.prod.yml restart

down-hard:
	@read -p "⚠️  Это удалит все данные! Продолжить? (y/N): " confirm && \
	if [ "$$confirm" = "y" ]; then \
		docker compose -f docker-compose.prod.yml down -v; \
	else \
		echo "Операция отменена."; \
	fi

studio:
	docker compose -f docker-compose.prod.yml exec bot npx prisma studio

logs:
	docker compose -f docker-compose.prod.yml logs -f --tail=100